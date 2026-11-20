import { randomBytes } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { TokenCipher } from "../src/crypto/tokenCipher.js";
import { connect } from "../src/db/client.js";
import {
  account,
  balanceSnapshot,
  holding,
  item,
  itemSecret,
  liability,
  syncRun,
  transaction,
} from "../src/db/schema.js";
import { PlaidApiError } from "../src/plaid/gateway.js";
import { linkItem } from "../src/sync/items.js";
import { SyncScheduler } from "../src/sync/scheduler.js";
import { syncItem } from "../src/sync/syncItem.js";
import { checking, FakePlaid, page, txn } from "./fakePlaid.js";
import { ownerUserId } from "./users.js";

const h = connect(inject("databaseUrl"));
const { db } = h;
const cipher = new TokenCipher(randomBytes(32).toString("base64"));
const userId = await ownerUserId(db);

afterAll(() => h.close());

beforeEach(async () => {
  await db.execute(sql`TRUNCATE item, security CASCADE`);
});

async function setup() {
  const plaid = new FakePlaid();
  plaid.accounts = [checking("100.00")];
  const itemId = await linkItem(db, plaid, cipher, userId, "public-1");
  return { plaid, itemId };
}

const liveTransactions = () =>
  db
    .select()
    .from(transaction)
    .where(sql`${transaction.removedAt} is null`)
    .orderBy(asc(transaction.plaidTransactionId));

describe("linkItem", () => {
  it("stores the access token encrypted, never in plaintext", async () => {
    const { itemId } = await setup();
    const [secret] = await db.select().from(itemSecret).where(eq(itemSecret.itemId, itemId));
    if (!secret) throw new Error("no secret stored");
    expect(secret.accessTokenCiphertext.toString("utf8")).not.toContain("access-public-1");
    expect(cipher.decrypt(secret.accessTokenCiphertext, itemId)).toBe("access-public-1");
  });
});

describe("syncItem", () => {
  it("syncs accounts, balances and transactions and stores the cursor", async () => {
    const { plaid, itemId } = await setup();
    plaid.onSync(null, page({ added: [txn("t1", "12.50")], hasMore: true, nextCursor: "c1" }));
    plaid.onSync("c1", page({ added: [txn("t2", "-2000")], nextCursor: "c2" }));

    const r = await syncItem(db, plaid, cipher, itemId);

    expect(r).toMatchObject({ status: "succeeded", added: 2, modified: 0, removed: 0 });
    const [it] = await db.select().from(item).where(eq(item.id, itemId));
    expect(it?.transactionsCursor).toBe("c2");
    expect(it?.lastSyncedAt).not.toBeNull();
    expect((await liveTransactions()).map((t) => [t.plaidTransactionId, t.amount])).toEqual([
      ["t1", "12.5000"],
      ["t2", "-2000.0000"],
    ]);
    const balances = await db.select().from(balanceSnapshot);
    expect(balances.map((b) => b.current)).toEqual(["100.0000"]);
  });

  it("continues from the stored cursor and handles pending -> posted", async () => {
    const { plaid, itemId } = await setup();
    plaid.onSync(null, page({ added: [txn("p1", "40.00", { pending: true })], nextCursor: "c1" }));
    await syncItem(db, plaid, cipher, itemId);

    plaid.onSync(
      "c1",
      page({
        added: [txn("t1", "42.00", { pendingTransactionId: "p1" })],
        removed: [{ transactionId: "p1" }],
        nextCursor: "c2",
      }),
    );
    const r = await syncItem(db, plaid, cipher, itemId);

    expect(r).toMatchObject({ status: "succeeded", added: 1, removed: 1 });
    expect(plaid.syncCalls).toEqual([null, "c1"]);
    const live = await liveTransactions();
    expect(live.map((t) => [t.plaidTransactionId, t.amount, t.pending])).toEqual([
      ["t1", "42.0000", false],
    ]);
    // Removed rows are kept for the audit trail, just marked.
    const [removed] = await db
      .select()
      .from(transaction)
      .where(eq(transaction.plaidTransactionId, "p1"));
    expect(removed?.removedAt).not.toBeNull();
  });

  it("applies modified transactions in place", async () => {
    const { plaid, itemId } = await setup();
    plaid.onSync(null, page({ added: [txn("t1", "10.00")], nextCursor: "c1" }));
    await syncItem(db, plaid, cipher, itemId);
    plaid.onSync("c1", page({ modified: [txn("t1", "11.00")], nextCursor: "c2" }));
    await syncItem(db, plaid, cipher, itemId);

    expect((await liveTransactions()).map((t) => t.amount)).toEqual(["11.0000"]);
  });

  it("restarts pagination from the original cursor when Plaid reports a mutation", async () => {
    const { plaid, itemId } = await setup();
    const mutation = new PlaidApiError(
      "TRANSACTIONS_ERROR",
      "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
      "changed",
    );
    plaid.onSync(null, page({ added: [txn("stale", "1.00")], hasMore: true, nextCursor: "c1" }));
    plaid.onSync("c1", mutation);
    plaid.onSync(null, page({ added: [txn("t1", "1.00")], hasMore: true, nextCursor: "c1" }));
    plaid.onSync("c1", page({ added: [txn("t2", "2.00")], nextCursor: "c2" }));

    const r = await syncItem(db, plaid, cipher, itemId);

    expect(r.status).toBe("succeeded");
    expect(plaid.syncCalls).toEqual([null, "c1", null, "c1"]);
    expect((await liveTransactions()).map((t) => t.plaidTransactionId)).toEqual(["t1", "t2"]);
  });

  it("marks the item for re-link on ITEM_LOGIN_REQUIRED and records the failed run", async () => {
    const { plaid, itemId } = await setup();
    plaid.accountsError = new PlaidApiError("ITEM_ERROR", "ITEM_LOGIN_REQUIRED", "login");

    const r = await syncItem(db, plaid, cipher, itemId);

    expect(r.status).toBe("failed");
    const [it] = await db.select().from(item).where(eq(item.id, itemId));
    expect(it).toMatchObject({ status: "relink_required", statusDetail: "ITEM_LOGIN_REQUIRED" });
    const [run] = await db.select().from(syncRun).where(eq(syncRun.itemId, itemId));
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("ITEM_LOGIN_REQUIRED");
  });

  it("retries an Item that failed on Plaid's side until it syncs, and leaves re-links alone", async () => {
    const { plaid, itemId } = await setup();
    const relinkId = await linkItem(db, plaid, cipher, userId, "public-2");
    await db
      .update(item)
      .set({ status: "relink_required", statusDetail: "ITEM_LOGIN_REQUIRED" })
      .where(eq(item.id, relinkId));
    plaid.accountsError = new PlaidApiError("API_ERROR", "INTERNAL_SERVER_ERROR", "unexpected");
    expect((await syncItem(db, plaid, cipher, itemId)).status).toBe("failed");
    const [failed] = await db.select().from(item).where(eq(item.id, itemId));
    expect(failed).toMatchObject({ status: "error", statusDetail: "INTERNAL_SERVER_ERROR" });

    plaid.accountsError = undefined;
    plaid.onSync(null, page({ added: [txn("t1", "1.00")], nextCursor: "c1" }));
    const scheduler = new SyncScheduler(db, plaid, cipher);
    expect(await scheduler.retryFailed()).toBe(1);
    const rows = await db.select().from(item);
    expect(rows.find((r) => r.id === itemId)).toMatchObject({
      status: "active",
      statusDetail: null,
    });
    expect(rows.find((r) => r.id === relinkId)?.status).toBe("relink_required");
    expect(await scheduler.retryFailed()).toBe(0);
  });

  it("replaces holdings with the latest snapshot and stores liabilities", async () => {
    const { plaid, itemId } = await setup();
    plaid.accounts = [
      checking("100.00"),
      {
        ...checking("0"),
        accountId: "acc-brokerage",
        name: "Brokerage",
        type: "investment",
        subtype: "brokerage",
      },
      {
        ...checking("500.00"),
        accountId: "acc-card",
        name: "Card",
        type: "credit",
        subtype: "credit card",
      },
    ];
    const sec = (id: string, ticker: string) => ({
      securityId: id,
      name: ticker,
      tickerSymbol: ticker,
      type: "etf",
      isCashEquivalent: false,
      closePrice: "100",
      closePriceAsOf: "2026-10-29",
      currency: "USD",
    });
    const pos = (securityId: string, quantity: string) => ({
      accountId: "acc-brokerage",
      securityId,
      quantity,
      institutionPrice: "100",
      institutionValue: String(Number(quantity) * 100),
      costBasis: null,
      currency: "USD",
    });
    plaid.holdings = {
      holdings: [pos("s-vti", "3.5"), pos("s-bnd", "2")],
      securities: [sec("s-vti", "VTI"), sec("s-bnd", "BND")],
    };
    plaid.liabilities = [
      {
        accountId: "acc-card",
        kind: "credit",
        aprPercentage: "24.99",
        lastStatementBalance: "480.12",
        minimumPayment: "35",
        nextPaymentDueDate: "2026-11-15",
        isOverdue: false,
      },
    ];
    plaid.onSync(null, page({ nextCursor: "c1" }));
    await syncItem(db, plaid, cipher, itemId);

    plaid.holdings = { holdings: [pos("s-vti", "4")], securities: [sec("s-vti", "VTI")] };
    plaid.onSync("c1", page({ nextCursor: "c2" }));
    await syncItem(db, plaid, cipher, itemId);

    const rows = await db.select().from(holding);
    expect(rows.map((r) => [r.securityId, r.quantity])).toEqual([["s-vti", "4.0000000000"]]);
    const [card] = await db.select().from(liability);
    expect(card).toMatchObject({
      kind: "credit",
      aprPercentage: "24.9900",
      minimumPayment: "35.0000",
    });
    expect(await db.select().from(account)).toHaveLength(3);
  });
});

describe("tidysum_agent role", () => {
  it("can read financial data but not access tokens or sync cursors", async () => {
    const { plaid, itemId } = await setup();
    plaid.onSync(null, page({ added: [txn("t1", "1.00")], nextCursor: "c1" }));
    await syncItem(db, plaid, cipher, itemId);

    const client = new pg.Client({ connectionString: inject("databaseUrl") });
    await client.connect();
    try {
      await client.query("SET ROLE tidysum_agent");
      await client.query("SELECT set_config('tidysum.user_id', $1, false)", [userId]);
      const { rows } = await client.query("SELECT count(*)::int AS n FROM transaction");
      expect(rows[0].n).toBe(1);
      await client.query("SELECT institution_name, status FROM item");
      await expect(client.query("SELECT * FROM item_secret")).rejects.toThrow(/permission denied/);
      await expect(client.query("SELECT transactions_cursor FROM item")).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query("DELETE FROM transaction")).rejects.toThrow(/permission denied/);
    } finally {
      await client.end();
    }
  });
});

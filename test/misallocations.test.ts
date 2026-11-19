import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { and, eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { TokenCipher } from "../src/crypto/tokenCipher.js";
import { connect } from "../src/db/client.js";
import {
  account,
  auditEvent,
  balanceSnapshot,
  item,
  liability,
  misallocation,
  policyVersion,
  transaction,
} from "../src/db/schema.js";
import { connectAgent } from "../src/mcp/agentDb.js";
import { createTidysumMcpServer } from "../src/mcp/server.js";
import {
  type Catalogs,
  catalogVersion,
  type MisallocationReport,
} from "../src/misallocation/detect.js";
import {
  listMisallocations,
  refreshMisallocations,
  setMisallocationState,
} from "../src/misallocation/ledger.js";
import { PlaidWebhookVerifier } from "../src/plaid/webhookVerifier.js";
import { loadPolicyFile } from "../src/policy/policy.js";
import { activatePolicy } from "../src/policy/store.js";
import { setCardAssignment } from "../src/products/cardAssignments.js";
import { parseCardCatalog } from "../src/products/cardCatalog.js";
import type { CardReport } from "../src/products/cards.js";
import { parseCatalog } from "../src/products/catalog.js";
import { setIraYear } from "../src/retirement/ira.js";
import { createApp } from "../src/server/app.js";
import { SyncScheduler } from "../src/sync/scheduler.js";
import { FakePlaid } from "./fakePlaid.js";
import { ownerUserId } from "./users.js";

const TODAY = "2026-10-30";
const at = (s: string) => new Date(s);

const deposits = parseCatalog({
  version: 1,
  products: [
    {
      id: "hy-savings",
      // The legal name differs from what the data source reports, as with Wealthfront.
      provider: "Better Brokerage LLC",
      institutions: ["better bank"],
      name: "HY Savings",
      kind: "savings",
      insurance: "FDIC",
      apy: [{ from: "0", apy: "4.00" }],
      monthly_fee: "0.00",
      overdraft_fees: false,
      source_url: "https://better.example/rates",
      rates_as_of: "2026-10-20",
      verified_on: "2026-10-29",
    },
  ],
});

const card = (over: Record<string, unknown>) => ({
  issuer: "Test Bank",
  annual_fee: "0",
  foreign_transaction_fee: "0",
  reward: { currency: "cash" },
  base_rate: "1",
  source_url: "https://bank.example/card",
  verified_on: "2026-10-29",
  ...over,
});

const cards = parseCardCatalog({
  version: 1,
  categories: {
    dining: { label: "Restaurants", codes: { plaid: ["FOOD_AND_DRINK_RESTAURANT"] } },
    groceries: { label: "Groceries", codes: { plaid: ["FOOD_AND_DRINK_GROCERIES"] } },
  },
  cards: [
    card({ id: "flat-2", name: "Flat Two", base_rate: "2", match: ["flat two"] }),
    card({
      id: "diner-3",
      name: "Diner Three",
      rates: [{ category: "dining", label: "dining", rate: "3" }],
    }),
  ],
});

const catalogs: Catalogs = { deposits, cards };
const owner = connect(inject("databaseUrl"));
const userId = await ownerUserId(owner.db);
const agentDb = connectAgent(inject("databaseUrl"), userId);
const ids = { item: "", checking: "", card: "" };
let client: Client;

async function seed() {
  const { db } = owner;
  await db.execute(sql`TRUNCATE item, security, misallocation CASCADE`);
  // This year's IRA is done, so Roth IRA room (test/ira.test.ts) stays out of these totals.
  await setIraYear(db, userId, {
    tax_year: 2026,
    as_of: "2026-04-01",
    traditional_contributed: "7500",
    converted: "7500",
  });
  const [it] = await db
    .insert(item)
    .values({
      userId,
      source: "plaid",
      plaidItemId: "mis-item",
      institutionName: "Big Bank",
      lastSyncedAt: at("2026-10-30T08:00:00Z"),
    })
    .returning();
  if (!it) throw new Error("no item");
  const [checking, cardAcct] = await db
    .insert(account)
    .values([
      { userId, itemId: it.id, name: "Checking", type: "depository", subtype: "checking" },
      {
        userId,
        itemId: it.id,
        name: "Card",
        officialName: "Flat Two Rewards",
        type: "credit",
        subtype: "credit card",
      },
    ])
    .returning();
  if (!checking || !cardAcct) throw new Error("no accounts");
  Object.assign(ids, { item: it.id, checking: checking.id, card: cardAcct.id });
  await db
    .insert(balanceSnapshot)
    .values([
      { userId, accountId: checking.id, current: "10000.00", asOf: at("2026-10-30T08:00:00Z") },
    ]);
  let n = 0;
  const t = (accountId: string, date: string, amount: string, detailed: string) => ({
    userId,
    accountId,
    plaidTransactionId: `m${++n}`,
    date,
    amount,
    name: detailed,
    categoryPrimary: detailed.split("_").slice(0, 2).join("_"),
    categoryDetailed: detailed,
    pending: false,
  });
  await db
    .insert(transaction)
    .values([
      t(checking.id, "2025-11-01", "-3000.00", "INCOME_WAGES"),
      t(cardAcct.id, "2026-03-01", "2000.00", "FOOD_AND_DRINK_GROCERIES"),
      t(checking.id, "2026-04-01", "1000.00", "FOOD_AND_DRINK_RESTAURANT"),
      t(cardAcct.id, "2026-06-01", "30.00", "BANK_FEES_FOREIGN_TRANSACTION_FEES"),
      t(cardAcct.id, "2026-07-01", "50.00", "BANK_FEES_INTEREST_CHARGE"),
    ]);
}

beforeAll(async () => {
  await seed();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createTidysumMcpServer(agentDb, undefined, {
    loadCatalog: async () => deposits,
    loadCardCatalog: async () => cards,
    today: () => TODAY,
  }).connect(serverTransport);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await agentDb.end();
  await owner.close();
});

async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await client.callTool({ name, arguments: args });
  const [first] = res.content as { text: string }[];
  if (res.isError) throw new Error(first?.text);
  return JSON.parse(first?.text ?? "null");
}

const record = (now: string, c: Catalogs = catalogs) =>
  refreshMisallocations(owner.db, agentDb, userId, c, TODAY, at(now));

async function rows() {
  const all = await owner.db.select().from(misallocation).where(eq(misallocation.userId, userId));
  return Object.fromEntries(all.map((r) => [r.key.replace(/:.*/, ""), r]));
}

describe("find_misallocations", () => {
  it("ranks everything costing money by yearly cost, with inputs and the catalog version", async () => {
    const r = await call<MisallocationReport>("find_misallocations");
    expect(r.items.map((m) => [m.key, m.category, m.annual_cost, m.state])).toEqual([
      // 10000 earning nothing; 4% elsewhere.
      [`deposit_rate:${ids.checking}`, "cash", "400.00", "new"],
      [`foreign_fees:${ids.card}`, "card", "30.00", "new"],
      // 1000 of dining paid from checking would earn 2% on the Flat Two card.
      ["card_usage", "card", "20.00", "new"],
      // Diner Three adds 1% over Flat Two on that 1000.
      ["card_wallet:diner-3", "card", "10.00", "new"],
    ]);
    expect(r).toMatchObject({
      annual_cost: "460.00",
      monthly_cost: "38.33",
      by_category: { cash: "400.00", card: "60.00", debt: "0.00", securities: "0.00" },
    });
    const [deposit] = r.items;
    expect(deposit?.product_id).toBe("hy-savings");
    expect(deposit?.inputs).toMatchObject({
      catalog: { name: "deposit-products", version: catalogVersion(deposits) },
      balance: "10000.00",
      alternative: { institutions: ["better bank"], source_url: "https://better.example/rates" },
    });
    expect(r.disclosure).toMatch(/not paid by any bank/);
    expect(r.not_covered.length).toBeGreaterThan(0);
  });

  it("compare_cards warns about the interest charged", async () => {
    const r = await call<CardReport>("compare_cards");
    expect(r.warnings).toContainEqual(expect.stringMatching(/charged 50.00 in interest/));
  });
});

describe("misallocation ledger", () => {
  it("records each finding once and audits it", async () => {
    expect(await record("2026-10-30T12:00:00Z")).toEqual({
      found: 4,
      changed: 0,
      reopened: 0,
      resolved: 0,
      withdrawn: 0,
    });
    expect(await record("2026-10-30T13:00:00Z")).toMatchObject({ found: 0, changed: 0 });
    const r = await rows();
    expect(r.deposit_rate).toMatchObject({ state: "open", annualCost: "400.0000" });
    expect(r.deposit_rate?.lastSeenAt).toEqual(at("2026-10-30T13:00:00Z"));
    expect(r.deposit_rate?.firstSeenAt).toEqual(at("2026-10-30T12:00:00Z"));
    const found = await owner.db
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.userId, userId), eq(auditEvent.event, "misallocation.found")));
    expect(found).toHaveLength(4);

    const report = await call<MisallocationReport>("find_misallocations");
    expect(report.items.every((m) => m.state === "open" && m.id)).toBe(true);
  });

  it("leaves a dismissed finding out of the total", async () => {
    const usage = (await rows()).card_usage;
    if (!usage) throw new Error("no card_usage row");
    expect(await setMisallocationState(owner.db, userId, usage.id, "dismissed", "test")).toBe(true);
    expect(await setMisallocationState(owner.db, userId, usage.id, "dismissed", "test")).toBe(
      false,
    );
    const r = await call<MisallocationReport>("find_misallocations");
    expect(r.annual_cost).toBe("440.00");
    expect(r.items.find((m) => m.key === "card_usage")?.state).toBe("dismissed");
  });

  it("doesn't close findings whose detector didn't run", async () => {
    expect(await record("2026-10-30T14:00:00Z", { deposits })).toMatchObject({
      resolved: 0,
      withdrawn: 0,
    });
    expect((await rows()).card_wallet?.state).toBe("open");
  });

  it("doesn't count a finding as acted on while its connection is out of date", async () => {
    const { db } = owner;
    const fee = eq(transaction.categoryDetailed, "BANK_FEES_FOREIGN_TRANSACTION_FEES");
    await db.update(item).set({ status: "relink_required" }).where(eq(item.id, ids.item));
    await db
      .update(transaction)
      .set({ removedAt: at("2026-10-30T14:30:00Z") })
      .where(fee);
    try {
      expect(await record("2026-10-30T15:00:00Z")).toMatchObject({ resolved: 0, withdrawn: 0 });
      expect((await rows()).foreign_fees?.state).toBe("open");
      const r = await call<MisallocationReport>("find_misallocations");
      expect(r.warnings).toContainEqual(
        expect.stringMatching(
          /^Big Bank is out of date \(relink_required, last synced 2026-10-30\)/,
        ),
      );
    } finally {
      await db.update(transaction).set({ removedAt: null }).where(fee);
      await db.update(item).set({ status: "active" }).where(eq(item.id, ids.item));
    }
    // A sync that is merely old counts as out of date too.
    await db
      .update(item)
      .set({ lastSyncedAt: at("2026-10-01T08:00:00Z") })
      .where(eq(item.id, ids.item));
    try {
      const r = await call<MisallocationReport>("find_misallocations");
      expect(r.warnings).toContainEqual(
        expect.stringMatching(/^Big Bank is out of date \(last synced 2026-10-01\)/),
      );
    } finally {
      await db
        .update(item)
        .set({ lastSyncedAt: at("2026-10-30T08:00:00Z") })
        .where(eq(item.id, ids.item));
    }
  });

  it("resolves findings the user acted on, and measures the ones it can", async () => {
    const { db } = owner;
    // The user opens the suggested account and moves the money there...
    const [better] = await db
      .insert(item)
      .values({
        userId,
        source: "plaid",
        plaidItemId: "better",
        institutionName: "Better Bank",
        lastSyncedAt: at("2026-10-30T08:00:00Z"),
      })
      .returning();
    if (!better) throw new Error("no item");
    const [savings] = await db
      .insert(account)
      .values({ userId, itemId: better.id, name: "HY", type: "depository", subtype: "savings" })
      .returning();
    if (!savings) throw new Error("no account");
    await db.insert(balanceSnapshot).values([
      { userId, accountId: ids.checking, current: "0.00", asOf: at("2026-10-30T20:00:00Z") },
      { userId, accountId: savings.id, current: "10000.00", asOf: at("2026-10-30T20:00:00Z") },
    ]);
    // ...gets the suggested card, and the foreign fee drops out of the window.
    const [diner] = await db
      .insert(account)
      .values({ userId, itemId: ids.item, name: "Diner", type: "credit", subtype: "credit card" })
      .returning();
    if (!diner) throw new Error("no account");
    await setCardAssignment(db, cards, userId, diner.id, "diner-3");
    await db
      .update(transaction)
      .set({ removedAt: at("2026-10-30T20:00:00Z") })
      .where(eq(transaction.categoryDetailed, "BANK_FEES_FOREIGN_TRANSACTION_FEES"));

    expect(await record("2026-10-30T21:00:00Z")).toMatchObject({ found: 0, resolved: 3 });
    const r = await rows();
    expect(r.deposit_rate).toMatchObject({ state: "resolved", realizedAnnualValue: null });
    expect(r.card_wallet).toMatchObject({ state: "resolved" });
    expect(r.foreign_fees).toMatchObject({ state: "resolved", realizedAnnualValue: "30.0000" });
    // Still found, still dismissed.
    expect(r.card_usage?.state).toBe("dismissed");
    // The new account isn't told to switch to itself.
    const report = await call<MisallocationReport>("find_misallocations");
    expect(report.items.map((m) => m.key)).toEqual(["card_usage"]);
  });

  it("measures realized interest a month after a switch", async () => {
    const [savings] = await owner.db
      .select()
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.name, "HY")));
    if (!savings) throw new Error("no account");
    await owner.db.insert(transaction).values({
      userId,
      accountId: savings.id,
      plaidTransactionId: "interest-1",
      date: "2026-11-30",
      amount: "-33.00",
      name: "Interest",
      categoryPrimary: "INCOME",
      categoryDetailed: "INCOME_INTEREST_EARNED",
      pending: false,
    });
    await record("2026-12-05T12:00:00Z");
    const r = await rows();
    // 33 over 35 days is 344.14 a year, against 0 before.
    expect(r.deposit_rate?.realizedAnnualValue).toBe("344.1400");
    expect(r.deposit_rate?.realizedBasis).toMatch(
      /33.00 interest at Better Brokerage LLC over 35 days/,
    );

    const { totals } = await listMisallocations(agentDb, { limit: 10 });
    expect(totals).toEqual({
      open_annual_cost: "0.00",
      resolved: 3,
      resolved_annual_cost: "440.00",
      realized_annual_value: "374.14",
    });
  });

  it("reopens a finding that comes back, and withdraws one that goes away on its own", async () => {
    const { db } = owner;
    await db.insert(balanceSnapshot).values({
      userId,
      accountId: ids.checking,
      current: "5000.00",
      asOf: at("2026-10-30T22:00:00Z"),
    });
    expect(await record("2026-10-30T23:00:00Z")).toMatchObject({ reopened: 1 });
    expect((await rows()).deposit_rate).toMatchObject({ state: "open", decidedAt: null });

    // The money leaves for somewhere that isn't the suggested bank.
    await db.delete(item).where(eq(item.plaidItemId, "better"));
    await db.insert(balanceSnapshot).values({
      userId,
      accountId: ids.checking,
      current: "0.00",
      asOf: at("2026-10-30T23:30:00Z"),
    });
    expect(await record("2026-10-31T00:00:00Z")).toMatchObject({ withdrawn: 1 });
    expect((await rows()).deposit_rate?.state).toBe("withdrawn");
    const events = await db
      .select({ event: auditEvent.event })
      .from(auditEvent)
      .where(and(eq(auditEvent.userId, userId), like(auditEvent.event, "misallocation.%")));
    expect(new Set(events.map((e) => e.event))).toEqual(
      new Set([
        "misallocation.found",
        "misallocation.dismissed",
        "misallocation.resolved",
        "misallocation.reopened",
        "misallocation.withdrawn",
      ]),
    );
  });

  it("agents can read the ledger but not write it", async () => {
    await expect(agentDb.query("update misallocation set state = 'dismissed'")).rejects.toThrow();
    const { misallocations } = await listMisallocations(agentDb, { state: "resolved", limit: 10 });
    expect(misallocations.length).toBe(2);
  });

  it("is on the admin API, with dismiss and undismiss", async () => {
    const ADMIN = "admin password that is long enough 0123";
    const plaid = new FakePlaid();
    const cipher = new TokenCipher(randomBytes(32).toString("base64"));
    const app = createApp({
      db: owner.db,
      plaid,
      cipher,
      scheduler: new SyncScheduler(owner.db, plaid, cipher),
      verifier: new PlaidWebhookVerifier(plaid),
      adminToken: ADMIN,
      daysRequested: 730,
      userId,
      agentDb,
      products: {
        loadCatalog: async () => deposits,
        loadCardCatalog: async () => cards,
        today: () => TODAY,
      },
    });
    const basic = `Basic ${Buffer.from(`owner:${ADMIN}`).toString("base64")}`;
    const headers = { Authorization: basic, "Content-Type": "application/json" };
    expect((await app.request("/api/misallocations")).status).toBe(401);
    const res = await app.request("/api/misallocations", { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as MisallocationReport & { totals: { resolved: number } };
    expect(body.items.map((m) => m.key)).toEqual(["card_usage"]);
    expect(body.totals.resolved).toBe(2);

    const usage = body.items[0]?.id;
    const post = async (path: string) =>
      (await app.request(path, { method: "POST", headers, body: "{}" })).status;
    expect(await post(`/api/misallocations/${usage}/undismiss`)).toBe(200);
    expect(await post(`/api/misallocations/${usage}/undismiss`)).toBe(404);
    expect(await post(`/api/misallocations/${usage}/dismiss`)).toBe(200);
    expect(await post("/api/misallocations/not-a-uuid/dismiss")).toBe(400);
  });
});

describe("policy findings", () => {
  it("includes a card statement once the card has charged interest", async () => {
    const { db } = owner;
    const had = await db.select().from(policyVersion).where(eq(policyVersion.userId, userId));
    if (had.length === 0) {
      await activatePolicy(db, userId, await loadPolicyFile("policy.example.json"));
    }
    try {
      await db.insert(balanceSnapshot).values({
        userId,
        accountId: ids.card,
        current: "500.00",
        asOf: at("2026-10-30T12:00:00Z"),
      });
      await db.insert(liability).values({
        userId,
        accountId: ids.card,
        kind: "credit",
        aprPercentage: "24.0000",
        lastStatementBalance: "500.00",
        nextPaymentDueDate: "2026-11-20",
        asOf: at("2026-10-30T12:00:00Z"),
      });
      const r = await call<MisallocationReport>("find_misallocations");
      // A year of 24% on the 500 statement beats the 50 actually charged.
      expect(r.items.find((m) => m.key === `card_statement:${ids.card}`)).toMatchObject({
        category: "card",
        detector: "card_statement",
        annual_cost: "120.00",
      });
      expect(await record("2026-10-31T01:00:00Z")).toMatchObject({ found: 1 });

      // Without interest charged, a statement that is due isn't money lost yet.
      await db
        .update(transaction)
        .set({ removedAt: at("2026-10-31T00:00:00Z") })
        .where(eq(transaction.categoryDetailed, "BANK_FEES_INTEREST_CHARGE"));
      const after = await call<MisallocationReport>("find_misallocations");
      expect(after.items.map((m) => m.key)).not.toContain(`card_statement:${ids.card}`);
    } finally {
      if (had.length === 0) {
        await db.delete(policyVersion).where(eq(policyVersion.userId, userId));
      }
    }
  });
});

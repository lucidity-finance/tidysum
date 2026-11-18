import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { TokenCipher } from "../src/crypto/tokenCipher.js";
import { connect } from "../src/db/client.js";
import {
  account,
  appUser,
  auditEvent,
  item,
  itemSecret,
  misallocation,
  policyVersion,
  proposal,
  proposalAction,
  transaction,
} from "../src/db/schema.js";
import { deleteUser, removeItem } from "../src/exits.js";
import { PlaidApiError } from "../src/plaid/gateway.js";
import { linkItem } from "../src/sync/items.js";
import { createUser } from "../src/users.js";
import { FakePlaid } from "./fakePlaid.js";
import { ownerUserId } from "./users.js";

const h = connect(inject("databaseUrl"));
const { db } = h;
const cipher = new TokenCipher(randomBytes(32).toString("base64"));
const owner = await ownerUserId(db);

afterAll(async () => {
  // The placeholder policies seeded below would otherwise be the newest, so the active policy, for
  // test files that run after this one.
  await db.execute(sql`TRUNCATE proposal CASCADE`);
  await db.delete(policyVersion).where(like(policyVersion.id, "v-%"));
  await h.close();
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE item, security, misallocation, proposal CASCADE`);
});

/** A linked Item with a checking and a card account, a transaction, a finding and a proposal. */
async function seed(userId: string, plaid: FakePlaid, publicToken: string) {
  const itemId = await linkItem(db, plaid, cipher, userId, publicToken);
  const [checking, card] = await db
    .insert(account)
    .values([
      { userId, itemId, name: "Checking", type: "depository" },
      { userId, itemId, name: "Card", type: "credit" },
    ])
    .returning();
  if (!checking || !card) throw new Error("no accounts");
  await db.insert(transaction).values({
    userId,
    accountId: card.id,
    plaidTransactionId: `fee-${publicToken}`,
    date: "2026-10-01",
    amount: "30.00",
    name: "Foreign fee",
    categoryDetailed: "BANK_FEES_FOREIGN_TRANSACTION_FEES",
    pending: false,
  });
  const finding = (key: string, detector: string, accountIds: string[]) => ({
    userId,
    key,
    category: "card" as const,
    detector,
    summary: key,
    annualCost: "30.00",
    accountIds,
    action: "fix it",
    inputs: {},
  });
  await db
    .insert(misallocation)
    .values([
      finding(`foreign_fees:${card.id}`, "foreign_fees", [card.id]),
      finding("card_usage", "card_usage", []),
      finding("other", "foreign_fees", [randomUUID()]),
    ]);
  await db
    .insert(policyVersion)
    .values({ userId, id: `v-${publicToken}`, content: {} })
    .onConflictDoNothing();
  const proposalId = randomUUID();
  await db.insert(proposal).values({
    id: proposalId,
    userId,
    policyVersionId: `v-${publicToken}`,
    source: "test",
    title: "Pay the card",
    rationale: "because",
    state: "proposed",
    category: "card",
    validation: {},
  });
  await db.insert(proposalAction).values({
    userId,
    proposalId,
    seq: 1,
    kind: "payment",
    fromAccountId: checking.id,
    toAccountId: card.id,
    amount: "30.00",
  });
  await db.insert(auditEvent).values({
    userId,
    actor: "test",
    event: "proposal.created",
    proposalId,
    data: { evidence: { accounts: [{ name: "Checking", current: "100.00" }] } },
  });
  return { itemId, proposalId, accountIds: [checking.id, card.id] };
}

const events = async (userId: string) =>
  (
    await db.select().from(auditEvent).where(eq(auditEvent.userId, userId)).orderBy(auditEvent.id)
  ).map((e) => e.event);

describe("removing a connection", () => {
  it("revokes it at Plaid and deletes its data, keeping the audit log", async () => {
    const plaid = new FakePlaid();
    const s = await seed(owner, plaid, "public-rm");
    const before = (await events(owner)).length;

    const r = await removeItem(db, plaid, cipher, owner, s.itemId, "test");

    expect(r).toEqual({
      institution_name: "First Platypus Bank",
      accounts: 2,
      proposals_deleted: 1,
      findings_withdrawn: 2,
    });
    expect(plaid.removed).toEqual(["access-public-rm"]);
    expect(await db.select().from(item).where(eq(item.id, s.itemId))).toEqual([]);
    expect(await db.select().from(itemSecret).where(eq(itemSecret.itemId, s.itemId))).toEqual([]);
    expect(await db.select().from(account).where(eq(account.itemId, s.itemId))).toEqual([]);
    expect(await db.select().from(transaction).where(eq(transaction.userId, owner))).toEqual([]);
    expect(await db.select().from(proposal).where(eq(proposal.id, s.proposalId))).toEqual([]);
    // Findings on the removed data are withdrawn, never counted as fixed; others are untouched.
    const states = Object.fromEntries(
      (await db.select().from(misallocation).where(eq(misallocation.userId, owner))).map((m) => [
        m.detector === "foreign_fees" && m.key !== "other" ? "fees" : m.key,
        m.state,
      ]),
    );
    expect(states).toEqual({ fees: "withdrawn", card_usage: "withdrawn", other: "open" });
    // The record of the proposal, evidence included, survives.
    const kept = await db
      .select()
      .from(auditEvent)
      .where(
        and(eq(auditEvent.proposalId, s.proposalId), eq(auditEvent.event, "proposal.created")),
      );
    expect(kept).toHaveLength(1);
    expect((await events(owner)).slice(before)).toEqual([
      "misallocation.withdrawn",
      "misallocation.withdrawn",
      "proposal.deleted",
      "item.removed",
    ]);
  });

  it("goes ahead when Plaid already removed the Item", async () => {
    const plaid = new FakePlaid();
    const s = await seed(owner, plaid, "public-gone");
    plaid.removeItem = async () => {
      throw new PlaidApiError("ITEM_ERROR", "ITEM_NOT_FOUND", "gone");
    };
    await removeItem(db, plaid, cipher, owner, s.itemId, "test");
    expect(await db.select().from(item).where(eq(item.id, s.itemId))).toEqual([]);
  });

  it("deletes nothing when Plaid refuses", async () => {
    const plaid = new FakePlaid();
    const s = await seed(owner, plaid, "public-down");
    plaid.removeItem = async () => {
      throw new PlaidApiError("API_ERROR", "INTERNAL_SERVER_ERROR", "down");
    };
    await expect(removeItem(db, plaid, cipher, owner, s.itemId, "test")).rejects.toThrow(
      /INTERNAL_SERVER_ERROR/,
    );
    expect(await db.select().from(item).where(eq(item.id, s.itemId))).toHaveLength(1);
  });

  it("only removes the user's own Items", async () => {
    const other = await createUser(db, "Someone else");
    try {
      const plaid = new FakePlaid({ ...new FakePlaid().info, itemId: "plaid-item-other" });
      const s = await seed(other, plaid, "public-other");
      await expect(removeItem(db, plaid, cipher, owner, s.itemId, "test")).rejects.toThrow(
        /no item/,
      );
      expect(plaid.removed).toEqual([]);
    } finally {
      await db.delete(appUser).where(eq(appUser.id, other));
    }
  });
});

describe("deleting a user", () => {
  it("revokes every Item and deletes all of the user's data except the audit log", async () => {
    const userId = await createUser(db, "Leaving");
    const plaid = new FakePlaid({ ...new FakePlaid().info, itemId: "plaid-item-leaving" });
    await seed(userId, plaid, "public-leave");

    expect(await deleteUser(db, plaid, cipher, userId, "test")).toEqual({ items: 1 });

    expect(plaid.removed).toEqual(["access-public-leave"]);
    expect(await db.select().from(appUser).where(eq(appUser.id, userId))).toEqual([]);
    for (const table of [item, account, transaction, misallocation, proposal, policyVersion]) {
      expect(await db.select().from(table).where(eq(table.userId, userId))).toEqual([]);
    }
    expect(await events(userId)).toEqual(["proposal.created", "user.deleted"]);
    // The owner's data is untouched.
    expect(await db.select().from(appUser).where(eq(appUser.id, owner))).toHaveLength(1);
  });
});

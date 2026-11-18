import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  type Action,
  decideAction,
  draftActions,
  getAction,
  listActions,
  listActivity,
  NEW_MONEY_KEY,
  setActionOrder,
} from "../src/actions/actions.js";
import { connect } from "../src/db/client.js";
import {
  account,
  appUser,
  auditEvent,
  balanceSnapshot,
  item,
  misallocation,
  policyVersion,
  proposal,
  transaction,
} from "../src/db/schema.js";
import { connectAgent } from "../src/mcp/agentDb.js";
import type { Catalogs } from "../src/misallocation/detect.js";
import { refreshMisallocations, setMisallocationState } from "../src/misallocation/ledger.js";
import { loadPolicyFile } from "../src/policy/policy.js";
import { approveProposal } from "../src/policy/proposals.js";
import { activatePolicy } from "../src/policy/store.js";
import type { AllocationResult } from "../src/portfolio/allocation.js";
import { parseCardCatalog } from "../src/products/cardCatalog.js";
import { parseCatalog } from "../src/products/catalog.js";

const TODAY = "2026-10-30";
const at = (s: string) => new Date(s);

const deposits = parseCatalog({
  version: 1,
  products: [
    {
      id: "hy-savings",
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
const categories = {
  dining: { label: "Restaurants", codes: { plaid: ["FOOD_AND_DRINK_RESTAURANT"] } },
  groceries: { label: "Groceries", codes: { plaid: ["FOOD_AND_DRINK_GROCERIES"] } },
};
const flatTwo = card({ id: "flat-2", name: "Flat Two", base_rate: "2", match: ["flat two"] });
const cards = parseCardCatalog({
  version: 1,
  categories,
  cards: [
    flatTwo,
    card({
      id: "diner-3",
      name: "Diner Three",
      rates: [{ category: "dining", label: "dining", rate: "3" }],
    }),
  ],
});

const catalogs: Catalogs = { deposits, cards };
const owner = connect(inject("databaseUrl"));
// A user of its own: audit events can't be deleted, and other files count the owner's.
const [actionsUser] = await owner.db
  .insert(appUser)
  .values({ displayName: "Actions test" })
  .returning({ id: appUser.id });
if (!actionsUser) throw new Error("no user");
const userId = actionsUser.id;
const agentDb = connectAgent(inject("databaseUrl"), userId);
const ids = { item: "", checking: "", card: "" };

beforeAll(async () => {
  const { db } = owner;
  await db.execute(sql`TRUNCATE item, security, misallocation, proposal, policy_version CASCADE`);
  await activatePolicy(db, userId, await loadPolicyFile("policy.example.json"));
  const [it] = await db
    .insert(item)
    .values({
      userId,
      source: "plaid",
      plaidItemId: "act-item",
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
  const t = (accountId: string, date: string, amount: string, detailed: string, name?: string) => ({
    userId,
    accountId,
    plaidTransactionId: `a${++n}`,
    date,
    amount,
    name: name ?? detailed,
    categoryPrimary: detailed.split("_").slice(0, 2).join("_"),
    categoryDetailed: detailed,
    pending: false,
  });
  await db
    .insert(transaction)
    .values([
      t(checking.id, "2025-11-01", "-3000.00", "INCOME_WAGES"),
      t(cardAcct.id, "2026-03-01", "2000.00", "FOOD_AND_DRINK_GROCERIES"),
      t(checking.id, "2026-04-01", "1000.00", "FOOD_AND_DRINK_RESTAURANT", "Bistro"),
      t(cardAcct.id, "2026-06-01", "30.00", "BANK_FEES_FOREIGN_TRANSACTION_FEES"),
    ]);
});

afterAll(async () => {
  await agentDb.end();
  await owner.close();
});

const record = (now: string, c: Catalogs = catalogs) =>
  refreshMisallocations(owner.db, agentDb, userId, c, TODAY, at(now));

const byKey = (list: Action[]) =>
  Object.fromEntries(list.map((a) => [a.finding_key?.replace(/:.*/, ""), a]));

async function events(id: string) {
  const rows = await owner.db
    .select({ event: auditEvent.event })
    .from(auditEvent)
    .where(eq(auditEvent.proposalId, id))
    .orderBy(auditEvent.id);
  return rows.map((r) => r.event);
}

describe("actions queue", () => {
  it("drafts one action per open finding, biggest yearly value first, with its steps", async () => {
    await record("2026-10-30T12:00:00Z");
    expect(await draftActions(owner.db, userId, at("2026-10-30T12:00:01Z"))).toMatchObject({
      drafted: 4,
    });
    const q = await listActions(agentDb, TODAY);
    expect(
      q.queue.map((a) => [a.finding_key?.replace(/:.*/, ""), a.expected_annual_value]),
    ).toEqual([
      ["deposit_rate", "400.00"],
      ["foreign_fees", "30.00"],
      ["card_usage", "20.00"],
      ["card_wallet", "10.00"],
    ]);
    const { deposit_rate: deposit, card_usage: usage, card_wallet: wallet } = byKey(q.queue);
    expect(deposit).toMatchObject({ source: "tidysum", state: "proposed", category: "cash" });
    expect(deposit?.steps).toEqual([
      {
        text: "Open a Better Brokerage LLC HY Savings account",
        by: "agent",
        needs_you: "Identity check and signature",
      },
      { text: "Link the new account in Connections", by: "you" },
      {
        text: "Move about $10,000 from Checking into it",
        by: "agent",
        needs_you: "Two-factor code",
      },
    ]);
    expect(deposit?.finding).toMatchObject({ detector: "deposit_rate", state: "open" });
    expect(usage?.steps[0]).toMatchObject({ text: "Switch Bistro to your best card" });
    expect(wallet?.steps[0]?.text).toBe("Apply for the Diner Three");
    expect(await events(deposit?.id ?? "")).toEqual(["proposal.created"]);
  });

  it("doesn't draft again, and nothing moves on a rerun with the same data", async () => {
    await record("2026-10-30T13:00:00Z");
    expect(await draftActions(owner.db, userId)).toEqual({
      drafted: 0,
      updated: 0,
      superseded: 0,
      confirmed: 0,
      withdrawn: 0,
    });
  });

  it("keeps the owner's own order, with ones they haven't placed first", async () => {
    const before = await listActions(agentDb, TODAY);
    const { deposit_rate: deposit, card_usage: usage, card_wallet: wallet } = byKey(before.queue);
    if (!deposit || !usage || !wallet) throw new Error("missing actions");
    // An id that isn't one of this owner's open actions is ignored.
    expect(
      await setActionOrder(owner.db, userId, [
        wallet.id,
        usage.id,
        crypto.randomUUID(),
        deposit.id,
      ]),
    ).toBe(3);
    const q = await listActions(agentDb, TODAY);
    expect(q.queue.map((a) => a.finding_key?.replace(/:.*/, ""))).toEqual([
      "foreign_fees",
      "card_wallet",
      "card_usage",
      "deposit_rate",
    ]);
    expect(byKey(q.queue).card_wallet?.position).toBe(0);
    expect(byKey(q.queue).foreign_fees?.position).toBeNull();
    // Dragging again moves them.
    await setActionOrder(owner.db, userId, [deposit.id, wallet.id, usage.id]);
    expect(
      (await listActions(agentDb, TODAY)).queue.map((a) => a.finding_key?.replace(/:.*/, "")),
    ).toEqual(["foreign_fees", "deposit_rate", "card_wallet", "card_usage"]);
  });

  it("not now hides an action for a week", async () => {
    const wallet = byKey((await listActions(agentDb, TODAY)).queue).card_wallet;
    if (!wallet) throw new Error("no card_wallet action");
    expect(await decideAction(owner.db, userId, wallet.id, "snooze", "test", TODAY)).toBe(true);
    const q = await listActions(agentDb, TODAY);
    expect(q.queue.map((a) => a.id)).not.toContain(wallet.id);
    expect(q.snoozed).toBe(1);
    const later = await listActions(agentDb, "2026-11-06");
    expect(later.queue.map((a) => a.id)).toContain(wallet.id);
    // Done needs an approval first.
    expect(await decideAction(owner.db, userId, wallet.id, "done", "test", TODAY)).toBe(false);
  });

  it("approve, then done, moves an action through the page", async () => {
    const deposit = byKey((await listActions(agentDb, TODAY)).queue).deposit_rate;
    if (!deposit) throw new Error("no deposit action");
    expect(
      await approveProposal(owner.db, agentDb, userId, deposit.id, TODAY, "test"),
    ).toMatchObject({ approved: true });
    expect((await listActions(agentDb, TODAY)).in_progress.map((a) => a.id)).toEqual([deposit.id]);
    expect(await decideAction(owner.db, userId, deposit.id, "done", "test", TODAY)).toBe(true);
    const q = await listActions(agentDb, TODAY);
    expect(q.in_progress).toEqual([]);
    expect(q.finished.map((a) => [a.id, a.state])).toEqual([[deposit.id, "done"]]);
  });

  it("don't suggest again dismisses the finding too; restoring it drafts a new action", async () => {
    const fees = byKey((await listActions(agentDb, TODAY)).queue).foreign_fees;
    if (!fees) throw new Error("no foreign_fees action");
    expect(await decideAction(owner.db, userId, fees.id, "dismiss", "test", TODAY)).toBe(true);
    const [finding] = await owner.db
      .select()
      .from(misallocation)
      .where(and(eq(misallocation.userId, userId), eq(misallocation.key, fees.finding_key ?? "")));
    expect(finding?.state).toBe("dismissed");
    expect(await draftActions(owner.db, userId)).toMatchObject({ drafted: 0 });

    if (!finding) throw new Error("no finding");
    await setMisallocationState(owner.db, userId, finding.id, "open", "test");
    expect(await draftActions(owner.db, userId)).toMatchObject({ drafted: 1 });
    const again = byKey((await listActions(agentDb, TODAY)).queue).foreign_fees;
    expect(again?.id).not.toBe(fees.id);
  });

  it("an agent's proposal for the same finding replaces Tidysum's draft", async () => {
    const usage = byKey((await listActions(agentDb, TODAY)).queue).card_usage;
    if (!usage) throw new Error("no card_usage action");
    const [policy] = await owner.db.select().from(policyVersion).limit(1);
    await owner.db.insert(proposal).values({
      id: crypto.randomUUID(),
      userId,
      policyVersionId: policy?.id ?? "",
      source: "mcp:claude",
      title: "Pay Bistro by card",
      rationale: "Earns 2% instead of nothing.",
      state: "proposed",
      category: "card",
      expectedAnnualValue: "20.00",
      findingKey: "card_usage",
      validation: { violations: [], warnings: [], numbers: {} },
    });
    expect(await draftActions(owner.db, userId)).toMatchObject({ superseded: 1, drafted: 0 });
    const q = byKey((await listActions(agentDb, TODAY)).queue);
    expect(q.card_usage).toMatchObject({ source: "mcp:claude", title: "Pay Bistro by card" });
    // It keeps the place the owner gave the draft it replaced.
    expect(q.card_usage?.position).toBe(usage.position);
    expect(usage.position).not.toBeNull();
    expect(await events(usage.id)).toEqual(["proposal.created", "proposal.superseded"]);
  });

  it("confirms an action when a sync shows its finding was acted on", async () => {
    const { db } = owner;
    const [better] = await db
      .insert(item)
      .values({
        userId,
        source: "plaid",
        plaidItemId: "act-better",
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
    expect(await record("2026-10-30T21:00:00Z")).toMatchObject({ resolved: 1 });
    expect(await draftActions(owner.db, userId)).toMatchObject({ confirmed: 1 });
    const [done] = (await listActions(agentDb, TODAY)).finished;
    expect(done).toMatchObject({ state: "confirmed", finding: { state: "resolved" } });
    expect(await events(done?.id ?? "")).toEqual([
      "proposal.created",
      "proposal.approved",
      "proposal.done",
      "proposal.confirmed",
    ]);
    const detail = await getAction(agentDb, done?.id ?? "");
    expect(detail?.history.map((h: { event: string }) => h.event)).toContain("proposal.confirmed");
  });

  it("lists recent activity newest first, with each action's title, and none of the churn", async () => {
    const feed = await listActivity(agentDb, 200);
    const confirmed = feed.find((e) => e.event === "proposal.confirmed");
    expect(confirmed).toMatchObject({ actor: "tidysum", category: "cash" });
    expect(confirmed?.title).toBeTruthy();
    expect(feed.find((e) => e.event === "proposal.approved")?.actor).toBe("test");
    expect(feed.some((e) => e.event === "misallocation.found" && e.title)).toBe(true);
    expect(feed.some((e) => (e.event as string) === "misallocation.changed")).toBe(false);
    const times = feed.map((e) => new Date(e.at).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("withdraws a waiting action when its finding goes away for another reason", async () => {
    const snoozed = byKey((await listActions(agentDb, "2026-11-06")).queue).card_wallet;
    if (!snoozed) throw new Error("no card_wallet action");
    // The better card leaves the catalog, so the suggestion simply stops.
    const fewer = parseCardCatalog({ version: 1, categories, cards: [flatTwo] });
    expect(await record("2026-10-30T22:00:00Z", { deposits, cards: fewer })).toMatchObject({
      withdrawn: 1,
    });
    expect(await draftActions(owner.db, userId)).toMatchObject({ withdrawn: 1 });
    const [row] = await owner.db.select().from(proposal).where(eq(proposal.id, snoozed.id));
    expect(row?.state).toBe("dismissed");
    expect(await events(snoozed.id)).toEqual([
      "proposal.created",
      "proposal.snoozed",
      "proposal.withdrawn",
    ]);
  });
});

describe("new money action", () => {
  const mix = (basis: "catch_up" | "target", split: [string, string][]) =>
    ({
      state: "ready",
      as_of: TODAY,
      buckets: [
        { key: "intl_stocks", label: "International stocks" },
        { key: "bonds_and_cash", label: "Bonds and cash" },
      ],
      new_money: {
        basis,
        catch_up: basis === "catch_up" ? "22" : null,
        split: split.map(([bucket, percent]) => ({
          bucket,
          percent,
          buy: { ticker: bucket === "intl_stocks" ? "VXUS" : "BND", name: null, held: false },
        })),
      },
    }) as unknown as AllocationResult;
  const under = mix("catch_up", [["intl_stocks", "100"]]);
  const newMoney = async () =>
    (await listActions(agentDb, TODAY)).queue.find((a) => a.finding_key === NEW_MONEY_KEY);

  it("puts where new money goes on a card, in percentages, with no selling", async () => {
    expect(await draftActions(owner.db, userId, new Date(), under)).toMatchObject({ drafted: 1 });
    const a = await newMoney();
    expect(a).toMatchObject({
      title: "Invest new money toward your target mix",
      carried_by: "tidysum",
      category: "securities",
      expected_annual_value: null,
      steps: [
        {
          text: "Put the money you invest from each paycheck into international stocks (VXUS)",
          by: "agent",
        },
        { text: "Leave everything you already hold as it is", by: "you" },
      ],
    });
    expect(await draftActions(owner.db, userId, new Date(), under)).toMatchObject({
      drafted: 0,
      updated: 0,
    });
    // Without the allocation, the action is left alone.
    expect(await draftActions(owner.db, userId)).toMatchObject({ withdrawn: 0, confirmed: 0 });
  });

  it("follows a new split while it waits", async () => {
    const both = mix("catch_up", [
      ["intl_stocks", "70"],
      ["bonds_and_cash", "30"],
    ]);
    expect(await draftActions(owner.db, userId, new Date(), both)).toMatchObject({ updated: 1 });
    const a = await newMoney();
    expect(a?.rationale).toBe(
      "Each paycheck you invest goes to international stocks + bonds and cash, so your mix drifts back to its target with no selling.",
    );
    expect(a?.steps[1]?.text).toBe(
      "Put 30% of what you invest from each paycheck into bonds and cash (BND)",
    );
  });

  it("is confirmed once the mix reaches its target", async () => {
    const a = await newMoney();
    if (!a) throw new Error("no new money action");
    expect(await approveProposal(owner.db, agentDb, userId, a.id, TODAY, "test")).toMatchObject({
      approved: true,
    });
    const onTarget = mix("target", [["intl_stocks", "30"]]);
    expect(await draftActions(owner.db, userId, new Date(), onTarget)).toMatchObject({
      confirmed: 1,
      drafted: 0,
    });
    const done = (await listActions(agentDb, TODAY)).finished.find((x) => x.id === a.id);
    expect(done?.state).toBe("confirmed");
  });

  it("don't suggest again keeps it away for a month", async () => {
    expect(await draftActions(owner.db, userId, new Date(), under)).toMatchObject({ drafted: 1 });
    const a = await newMoney();
    if (!a) throw new Error("no new money action");
    expect(await decideAction(owner.db, userId, a.id, "dismiss", "test", TODAY)).toBe(true);
    expect(await draftActions(owner.db, userId, new Date(), under)).toMatchObject({ drafted: 0 });
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect(await draftActions(owner.db, userId, later, under)).toMatchObject({ drafted: 1 });
  });

  it("is withdrawn while waiting when investing is off", async () => {
    const off = { state: "off", as_of: TODAY } as AllocationResult;
    expect(await draftActions(owner.db, userId, new Date(), off)).toMatchObject({ withdrawn: 1 });
    expect(await newMoney()).toBeUndefined();
  });
});

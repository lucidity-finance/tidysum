import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { draftActions, listActions } from "../src/actions/actions.js";
import { connect } from "../src/db/client.js";
import { account, appUser, balanceSnapshot, item, misallocation } from "../src/db/schema.js";
import { connectAgent } from "../src/mcp/agentDb.js";
import type { Catalogs } from "../src/misallocation/detect.js";
import { refreshMisallocations } from "../src/misallocation/ledger.js";
import { parsePolicy } from "../src/policy/policy.js";
import { activatePolicy } from "../src/policy/store.js";
import { parseCatalog } from "../src/products/catalog.js";
import { productLabel, readAndCompare } from "../src/products/compare.js";
import { setDepositChoice } from "../src/products/depositChoices.js";

const TODAY = "2026-11-12";
const product = (over: Record<string, unknown>) => ({
  institutions: ["other bank"],
  kind: "savings",
  insurance: "FDIC",
  monthly_fee: "0.00",
  overdraft_fees: false,
  rates_as_of: "2026-11-01",
  verified_on: "2026-11-10",
  ...over,
});
const deposits = parseCatalog({
  version: 1,
  products: [
    product({
      id: "top-rate",
      provider: "Top Rate Brokerage LLC",
      name: "Top Rate Cash Account",
      apy: [{ from: "0", apy: "4.00" }],
      source_url: "https://top.example/rates",
    }),
    product({
      id: "pay-bank",
      provider: "PayBank, N.A.",
      institutions: ["paybank"],
      name: "PayBank Savings",
      apy: [{ from: "0", apy: "0.50" }],
      conditional_apy: {
        apy: [{ from: "0", apy: "3.50" }],
        requires: "Eligible Direct Deposit",
      },
      source_url: "https://paybank.example/rates",
    }),
    product({
      id: "low-rate",
      provider: "Low Bank",
      name: "Low Savings",
      apy: [{ from: "0", apy: "0.00" }],
      source_url: "https://low.example/rates",
    }),
  ],
});
const catalogs: Catalogs = { deposits };

const owner = connect(inject("databaseUrl"));
// A user of its own: audit events can't be deleted, and other files count the owner's.
const [choiceUser] = await owner.db
  .insert(appUser)
  .values({ displayName: "Deposit choice test" })
  .returning({ id: appUser.id });
if (!choiceUser) throw new Error("no user");
const userId = choiceUser.id;
const agentDb = connectAgent(inject("databaseUrl"), userId);
let checking = "";

beforeAll(async () => {
  const { db } = owner;
  await activatePolicy(db, userId, parsePolicy({ version: 1, cash: { buffer: { amount: "0" } } }));
  const [it] = await db
    .insert(item)
    .values({
      userId,
      source: "plaid",
      plaidItemId: "choice-item",
      institutionName: "Big Bank",
      lastSyncedAt: new Date("2026-11-12T08:00:00Z"),
    })
    .returning();
  if (!it) throw new Error("no item");
  const [acct] = await db
    .insert(account)
    .values({ userId, itemId: it.id, name: "Checking", type: "depository", subtype: "checking" })
    .returning();
  if (!acct) throw new Error("no account");
  checking = acct.id;
  await db.insert(balanceSnapshot).values({
    userId,
    accountId: checking,
    current: "10000.00",
    asOf: new Date("2026-11-12T08:00:00Z"),
  });
});

afterAll(async () => {
  await agentDb.end();
  await owner.close();
});

const refresh = async () => {
  await refreshMisallocations(owner.db, agentDb, userId, catalogs, TODAY);
  await draftActions(owner.db, userId);
  return listActions(agentDb, TODAY);
};

async function finding() {
  const [row] = await owner.db
    .select()
    .from(misallocation)
    .where(
      and(eq(misallocation.userId, userId), eq(misallocation.key, `deposit_rate:${checking}`)),
    );
  return row;
}

describe("the owner's pick of where spare cash goes", () => {
  it("without a pick, the action follows the best rate", async () => {
    const { queue } = await refresh();
    expect(queue.map((a) => a.title)).toEqual(["Move the balance to Top Rate Cash Account."]);
    expect(queue[0]?.steps.map((s) => s.text)).toEqual([
      "Open a Top Rate Cash Account",
      "Link the new account in Connections",
      "Move about $10,000 from Checking into it",
    ]);
  });

  it("a pick leads the comparison, and the waiting action switches to it with the paycheck steps", async () => {
    await setDepositChoice(owner.db, deposits, userId, checking, "pay-bank");
    const compared = await readAndCompare(agentDb, deposits, TODAY);
    const acct = compared.accounts.find((a) => a.account_id === checking);
    expect(acct?.chosen_product_id).toBe("pay-bank");
    expect(acct?.alternatives.map((a) => a.product_id)).toEqual(["pay-bank", "top-rate"]);

    const { queue } = await refresh();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      title: "Move the balance to PayBank Savings.",
      expected_annual_value: "350.00",
    });
    expect(queue[0]?.steps).toEqual([
      {
        text: "Open a PayBank Savings account",
        by: "agent",
        needs_you: "Identity check and signature",
      },
      { text: "Link the new account in Connections", by: "you" },
      {
        text: "Send your paycheck's direct deposit to it",
        by: "agent",
        needs_you: "Payroll sign-in",
      },
      {
        text: "Move the bills and autopays paid from Checking to it, or leave enough in Checking to cover them",
        by: "agent",
        needs_you: "Sign-ins",
      },
      {
        text: "Move about $10,000 from Checking into it",
        by: "agent",
        needs_you: "Two-factor code",
      },
    ]);
    expect((await finding())?.inputs).toMatchObject({ chosen_by_owner: true });
  });

  it("a pick that pays no more than today leaves nothing to fix", async () => {
    await expect(
      setDepositChoice(owner.db, deposits, userId, checking, "no-such-product"),
    ).rejects.toThrow(/unknown product/);
    await setDepositChoice(owner.db, deposits, userId, checking, "low-rate");
    const { queue } = await refresh();
    expect(queue).toEqual([]);
    expect((await finding())?.state).toBe("withdrawn");
  });

  it("clearing the pick goes back to the best rate", async () => {
    await setDepositChoice(owner.db, deposits, userId, checking, null);
    const { queue } = await refresh();
    expect(queue.map((a) => a.title)).toEqual(["Move the balance to Top Rate Cash Account."]);
  });

  it("only the owner side sets it, and another user's account is refused", async () => {
    await expect(
      agentDb.query(
        "insert into deposit_choice (account_id, user_id, product_id) values ($1, $2, 'x')",
        [checking, userId],
      ),
    ).rejects.toThrow(/read-only|permission denied/);
    await expect(
      setDepositChoice(owner.db, deposits, crypto.randomUUID(), checking, "pay-bank"),
    ).rejects.toThrow(/no cash account/);
  });

  it("names products without repeating the brand", () => {
    expect(productLabel("SoFi Bank, N.A.", "SoFi Savings")).toBe("SoFi Savings");
    expect(productLabel("Wealthfront Brokerage LLC", "Wealthfront Cash Account")).toBe(
      "Wealthfront Cash Account",
    );
    expect(productLabel("Ally Bank", "Online Savings")).toBe("Ally Bank Online Savings");
  });
});

describe("an account that already is the owner's pick", () => {
  let savings = "";

  beforeAll(async () => {
    const { db } = owner;
    const [it] = await db
      .insert(item)
      .values({
        userId,
        source: "plaid",
        plaidItemId: "choice-paybank-item",
        institutionName: "PayBank",
        lastSyncedAt: new Date("2026-11-12T08:00:00Z"),
      })
      .returning();
    if (!it) throw new Error("no item");
    const [acct] = await db
      .insert(account)
      .values({
        userId,
        itemId: it.id,
        name: "PayBank Savings",
        type: "depository",
        subtype: "savings",
      })
      .returning();
    if (!acct) throw new Error("no account");
    savings = acct.id;
    // Newly opened: a balance, but no interest has posted yet.
    await db.insert(balanceSnapshot).values({
      userId,
      accountId: savings,
      current: "2000.00",
      asOf: new Date("2026-11-12T08:00:00Z"),
    });
  });

  it("earns the published rate before its first interest posts, the direct-deposit one once picked", async () => {
    let compared = await readAndCompare(agentDb, deposits, TODAY);
    let acct = compared.accounts.find((a) => a.account_id === savings);
    expect(acct?.current).toMatchObject({ annual_interest: "10.00", effective_apy: "0.50" });
    expect(acct?.holds_choice).toBeUndefined();
    expect(acct?.alternatives[0]?.product_id).toBe("top-rate");

    await setDepositChoice(owner.db, deposits, userId, checking, "pay-bank");
    compared = await readAndCompare(agentDb, deposits, TODAY);
    acct = compared.accounts.find((a) => a.account_id === savings);
    expect(acct?.current).toMatchObject({ annual_interest: "70.00", effective_apy: "3.50" });
    expect(acct?.current.basis).toMatch(/PayBank Savings's published 3\.50% APY/);
    expect(acct?.holds_choice).toBe(true);
    expect(acct?.alternatives).toEqual([]);
  });

  it("is not told to move to another bank, while the old account's action stays", async () => {
    const { queue } = await refresh();
    expect(queue.map((a) => a.title)).toEqual(["Move the balance to PayBank Savings."]);
    const [row] = await owner.db
      .select()
      .from(misallocation)
      .where(
        and(eq(misallocation.userId, userId), eq(misallocation.key, `deposit_rate:${savings}`)),
      );
    expect(row?.state ?? "none").not.toBe("open");
  });
});

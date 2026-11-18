import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Big from "big.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { connect } from "../src/db/client.js";
import { account, balanceSnapshot, item, transaction } from "../src/db/schema.js";
import { connectAgent } from "../src/mcp/agentDb.js";
import { createTidysumMcpServer } from "../src/mcp/server.js";
import { parsePolicy } from "../src/policy/policy.js";
import { activatePolicy } from "../src/policy/store.js";
import { type CashHistory, dailyRate } from "../src/products/cashHistory.js";
import { parseCatalog } from "../src/products/catalog.js";
import type { Comparison } from "../src/products/compare.js";
import { ownerUserId } from "./users.js";

const TODAY = "2026-10-30";

const product = (over: Record<string, unknown>) => ({
  provider: "Test Bank",
  institutions: ["test bank"],
  insurance: "FDIC",
  monthly_fee: "0.00",
  overdraft_fees: false,
  source_url: "https://bank.example/rates",
  rates_as_of: "2026-10-20",
  verified_on: "2026-10-29",
  ...over,
});

const catalog = parseCatalog({
  version: 1,
  products: [
    product({
      id: "hy-savings",
      name: "HY Savings",
      kind: "savings",
      apy: [{ from: "0", apy: "4.00" }],
      // Conditions aren't counted: nobody can meet them retroactively.
      conditional_apy: { apy: [{ from: "0", apy: "9.00" }], requires: "direct deposit" },
    }),
    product({
      id: "mid-cash",
      name: "Mid Cash",
      kind: "cash_management",
      apy: [{ from: "0", apy: "3.00" }],
    }),
    // Checking isn't a place to park idle cash, so it isn't a benchmark.
    product({
      id: "rich-checking",
      name: "Rich Checking",
      kind: "checking",
      apy: [{ from: "0", apy: "8.00" }],
    }),
  ],
});

const owner = connect(inject("databaseUrl"));
const userId = await ownerUserId(owner.db);
const agentDb = connectAgent(inject("databaseUrl"), userId);
const ids = { checking: "", savings: "" };
const at = (s: string) => new Date(s);

async function seed() {
  const { db } = owner;
  await db.execute(sql`TRUNCATE item, security, policy_version CASCADE`);
  const [it] = await db
    .insert(item)
    .values({ userId, source: "plaid", plaidItemId: "hist-item", institutionName: "Chase" })
    .returning();
  if (!it) throw new Error("no item");
  const [checking, savings] = await db
    .insert(account)
    .values([
      { userId, itemId: it.id, name: "Total Checking", type: "depository", subtype: "checking" },
      { userId, itemId: it.id, name: "Savings", type: "depository", subtype: "savings" },
      { userId, itemId: it.id, name: "Card", type: "credit", subtype: "credit card" },
    ])
    .returning();
  if (!checking || !savings) throw new Error("no accounts");
  Object.assign(ids, { checking: checking.id, savings: savings.id });

  await db.insert(balanceSnapshot).values([
    // Synced earlier, and matching what the transactions say the balance was that day.
    { userId, accountId: checking.id, current: "6000.00", asOf: at("2026-03-01T12:00:00Z") },
    { userId, accountId: checking.id, current: "12000.00", asOf: at("2026-10-30T09:00:00Z") },
    { userId, accountId: savings.id, current: "5000.00", asOf: at("2026-10-30T09:00:00Z") },
  ]);

  let n = 0;
  const t = (
    accountId: string,
    date: string,
    amount: string,
    detailed: string,
    extra: Partial<typeof transaction.$inferInsert> = {},
  ) => ({
    userId,
    accountId,
    plaidTransactionId: `h${++n}`,
    date,
    amount,
    name: "x",
    categoryPrimary: detailed.split("_")[0] ?? null,
    categoryDetailed: detailed,
    pending: false,
    ...extra,
  });
  await db.insert(transaction).values([
    t(checking.id, "2025-10-31", "-1000.00", "INCOME_WAGES"),
    t(checking.id, "2026-04-30", "-6000.00", "INCOME_WAGES"),
    // Not part of the balance: pending, or replaced.
    t(checking.id, "2026-05-10", "500.00", "GENERAL_MERCHANDISE_OTHER", { pending: true }),
    t(checking.id, "2026-05-11", "700.00", "GENERAL_MERCHANDISE_OTHER", {
      removedAt: at("2026-05-12T00:00:00Z"),
    }),
    t(savings.id, "2026-01-31", "-10.00", "INCOME_INTEREST_EARNED"),
  ]);
}

let client: Client;

async function history(): Promise<CashHistory> {
  const res = await client.callTool({ name: "idle_cash_history", arguments: {} });
  const [first] = res.content as { text: string }[];
  if (res.isError) throw new Error(first?.text);
  return JSON.parse(first?.text ?? "null");
}

beforeAll(async () => {
  await seed();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createTidysumMcpServer(agentDb, undefined, {
    loadCatalog: async () => catalog,
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

/** What `apy` pays on `balance` for `days` days, compounded daily. */
const earned = (balance: string, apy: string, days: number) =>
  new Big(balance).times(dailyRate(new Big(apy))).times(days);

describe("dailyRate", () => {
  it("compounds back to the APY over a year", () => {
    for (const apy of ["0.01", "3.20", "4.00", "5.25"]) {
      let grown = new Big(1);
      const r = dailyRate(new Big(apy));
      for (let i = 0; i < 365; i++) grown = grown.times(new Big(1).plus(r)).round(25);
      expect(grown.minus(1).times(100).toFixed(8)).toBe(new Big(apy).toFixed(8));
    }
  });
});

describe("idle_cash_history", () => {
  it("is a read-only tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.find((x) => x.name === "idle_cash_history")?.annotations?.readOnlyHint).toBe(true);
  });

  it("without a policy, counts every dollar as idle", async () => {
    const r = await history();
    expect(r.buffer).toBe("0.00");
    expect(r.warnings.join(" ")).toMatch(/No policy is set/);
  });

  it("rebuilds daily balances from transactions and prices the cash above the buffer", async () => {
    await activatePolicy(
      owner.db,
      userId,
      parsePolicy({ version: 1, cash: { buffer: { amount: "5000" } } }),
    );
    const r = await history();
    expect(r.window).toEqual({ from: "2025-10-31", to: TODAY, days: 365 });
    expect(r.buffer).toBe("5000.00");
    expect(r.buffer_basis).toBe("your policy's cash buffer");

    // Checking: 6000 until the 6000 deposit on 2026-04-30, then 12000. Savings: 4990 until the
    // interest credit on 2026-01-31, then 5000. Above the 5000 buffer: 5990 for 92 days, 6000
    // for 89 days, 12000 for 184 days.
    const spans: [string, number][] = [
      ["5990", 92],
      ["6000", 89],
      ["12000", 184],
    ];
    const at = (apy: string) =>
      spans.reduce((s, [b, d]) => s.plus(earned(b, apy, d)), new Big(0)).toFixed(2);
    expect(r.interest_earned).toBe("10.00");
    expect(r.benchmarks.map((b) => [b.product_id, b.apy, b.would_have_earned])).toEqual([
      ["hy-savings", "4.00", at("4.00")],
      ["mid-cash", "3.00", at("3.00")],
    ]);
    expect(r.best?.product_id).toBe("hy-savings");
    const lost = new Big(at("4.00")).minus(10).toFixed(2);
    expect(r.lost).toBe(lost);
    expect(r.lost_per_year).toBe(lost);
    expect(r.last_365_days).toEqual({
      would_have_earned: at("4.00"),
      interest_earned: "10.00",
      lost,
    });
    // Sanity check against simple interest: roughly 4% of the average idle balance.
    expect(Number(r.lost)).toBeGreaterThan(330);
    expect(Number(r.lost)).toBeLessThan(345);

    const avgIdle = new Big(5990 * 92 + 6000 * 89 + 12000 * 184).div(365).toFixed(2);
    expect(r.average_idle).toBe(avgIdle);
    expect(r.average_balance).toBe(new Big(avgIdle).plus(5000).toFixed(2));

    const checking = r.accounts.find((a) => a.id === ids.checking);
    expect(checking).toMatchObject({
      latest_balance: "12000.00",
      first_transaction: "2025-10-31",
      check: { snapshots: 1, largest_difference: "0.00" },
    });
    expect(r.accounts.find((a) => a.id === ids.savings)?.interest_earned).toBe("10.00");
    expect(r.accounts).toHaveLength(2);
  });

  it("breaks the loss down by month", async () => {
    const r = await history();
    expect(r.monthly.map((m) => m.month)).toEqual([
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    expect(r.monthly[0]).toMatchObject({ days: 1, average_idle: "5990.00" });
    const jan = r.monthly.find((m) => m.month === "2026-01");
    // 30 days at 5990 and one at 6000, and 10.00 earned, so less lost that month.
    expect(jan?.average_idle).toBe(new Big(5990 * 30 + 6000).div(31).toFixed(2));
    expect(jan?.interest_earned).toBe("10.00");
    expect(jan?.would_have_earned).toBe(
      earned("5990", "4.00", 30)
        .plus(earned("6000", "4.00", 1))
        .toFixed(2),
    );
    expect(r.monthly.find((m) => m.month === "2026-06")).toMatchObject({
      days: 30,
      average_balance: "17000.00",
      average_idle: "12000.00",
      interest_earned: "0.00",
      lost: earned("12000", "4.00", 30).toFixed(2),
    });
    const sum = r.monthly.reduce((s, m) => s.plus(m.would_have_earned), new Big(0));
    expect(
      sum
        .minus(r.best?.would_have_earned ?? 0)
        .abs()
        .lte("0.07"),
    ).toBe(true);
  });

  it("accepts a snapshot taken before that day's deposit reached the balance", async () => {
    // The 6000 deposit is dated 2026-04-30, but a snapshot that day still shows 6000.
    await owner.db.insert(balanceSnapshot).values({
      userId,
      accountId: ids.checking,
      current: "6000.00",
      asOf: at("2026-04-30T15:00:00Z"),
    });
    const r = await history();
    expect(r.accounts.find((a) => a.id === ids.checking)?.check).toEqual({
      snapshots: 2,
      largest_difference: "0.00",
    });
    expect(r.warnings.join(" ")).not.toMatch(/differs/);
  });

  it("averages compare_products' balance over rebuilt days", async () => {
    const res = await client.callTool({ name: "compare_products", arguments: {} });
    const [first] = res.content as { text: string }[];
    const r = JSON.parse(first?.text ?? "null") as Comparison;
    // 08-02 to 10-30: 12000 every day, though no snapshot exists before today.
    expect(r.accounts.find((a) => a.account_id === ids.checking)).toMatchObject({
      balance: "12000.00",
      balance_basis: "average of the last 90 days' balances, rebuilt from transactions",
    });
  });

  it("flags a synced balance the transactions can't explain", async () => {
    await owner.db.insert(balanceSnapshot).values({
      userId,
      accountId: ids.checking,
      current: "9000.00",
      asOf: at("2026-06-15T12:00:00Z"),
    });
    const r = await history();
    expect(r.accounts.find((a) => a.id === ids.checking)?.check).toEqual({
      snapshots: 3,
      largest_difference: "3000.00",
    });
    expect(r.warnings.join(" ")).toMatch(/Total Checking: a balance synced earlier differs/);
  });

  it("falls back to snapshots for an account younger than 90 days", async () => {
    await owner.db.execute(sql`TRUNCATE item CASCADE`);
    const [it] = await owner.db
      .insert(item)
      .values({ userId, source: "plaid", plaidItemId: "young", institutionName: "Chase" })
      .returning();
    const [acct] = await owner.db
      .insert(account)
      .values({
        userId,
        itemId: it?.id ?? "",
        name: "New Checking",
        type: "depository",
        subtype: "checking",
      })
      .returning();
    const accountId = acct?.id ?? "";
    await owner.db.insert(balanceSnapshot).values([
      { userId, accountId, current: "1000.00", asOf: at("2026-10-29T12:00:00Z") },
      { userId, accountId, current: "3000.00", asOf: at("2026-10-30T09:00:00Z") },
    ]);
    await owner.db.insert(transaction).values({
      userId,
      accountId,
      plaidTransactionId: "young-1",
      date: "2026-10-01",
      amount: "-3000.00",
      name: "x",
      pending: false,
    });
    const res = await client.callTool({ name: "compare_products", arguments: {} });
    const [first] = res.content as { text: string }[];
    const r = JSON.parse(first?.text ?? "null") as Comparison;
    expect(r.accounts[0]).toMatchObject({
      balance: "2000.00",
      balance_basis: "average of 2 daily balances in the last 90 days",
    });
  });

  it("says so when there is nothing to rebuild from", async () => {
    await owner.db.execute(sql`TRUNCATE item CASCADE`);
    const r = await history();
    expect(r.window).toBeNull();
    expect(r.lost).toBe("0.00");
    expect(r.warnings.join(" ")).toMatch(/No posted transactions/);
  });
});

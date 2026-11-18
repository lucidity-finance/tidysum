import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Big from "big.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { productsPath } from "../src/config.js";
import { TokenCipher } from "../src/crypto/tokenCipher.js";
import { connect } from "../src/db/client.js";
import { account, balanceSnapshot, item, transaction } from "../src/db/schema.js";
import { connectAgent } from "../src/mcp/agentDb.js";
import { createTidysumMcpServer } from "../src/mcp/server.js";
import { PlaidWebhookVerifier } from "../src/plaid/webhookVerifier.js";
import { apyFor, loadCatalogFile, parseCatalog } from "../src/products/catalog.js";
import type { Comparison } from "../src/products/compare.js";
import { createApp } from "../src/server/app.js";
import { SyncScheduler } from "../src/sync/scheduler.js";
import { FakePlaid } from "./fakePlaid.js";
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
      apy: [{ from: "0", apy: "0.50" }],
      conditional_apy: { apy: [{ from: "0", apy: "4.00" }], requires: "direct deposit" },
    }),
    product({
      id: "tiered-checking",
      name: "Tiered Checking",
      kind: "checking",
      apy: [
        { from: "0", apy: "0.10" },
        { from: "10000", apy: "1.00" },
      ],
    }),
    product({
      id: "fee-checking",
      name: "Fee Checking",
      kind: "checking",
      apy: [{ from: "0", apy: "2.00" }],
      monthly_fee: "5.00",
      overdraft_fees: true,
      verified_on: "2026-08-01",
    }),
  ],
});

describe("product catalog", () => {
  it("the checked-in catalog is valid and every rate has an https source", async () => {
    const real = await loadCatalogFile(productsPath({}));
    expect(real.products.length).toBeGreaterThan(0);
    for (const p of real.products) {
      expect(p.source_url).toMatch(/^https:\/\//);
      expect(p.verified_on >= p.rates_as_of).toBe(true);
    }
  });

  it("applies the highest tier the balance reaches to the whole balance", () => {
    const tiers = [
      { from: "0", apy: "0.10" },
      { from: "15000", apy: "0.25" },
    ];
    expect(apyFor(tiers, new Big("14999.99")).toFixed(2)).toBe("0.10");
    expect(apyFor(tiers, new Big("15000")).toFixed(2)).toBe("0.25");
  });

  it("rejects tiers out of order, missing sources and duplicate ids", () => {
    const bad = (p: Record<string, unknown>) => () =>
      parseCatalog({
        version: 1,
        products: [product({ id: "x", name: "X", kind: "savings", ...p })],
      });
    expect(
      bad({
        apy: [
          { from: "0", apy: "1" },
          { from: "0", apy: "2" },
        ],
      }),
    ).toThrow(/increasing order/);
    expect(bad({ apy: [{ from: "5", apy: "1" }] })).toThrow(/start at 0/);
    expect(bad({ apy: [{ from: "0", apy: "1" }], source_url: "http://bank.example" })).toThrow(
      /https/,
    );
    const p = product({ id: "x", name: "X", kind: "savings", apy: [{ from: "0", apy: "1" }] });
    expect(() => parseCatalog({ version: 1, products: [p, p] })).toThrow(/unique/);
  });
});

const owner = connect(inject("databaseUrl"));
const userId = await ownerUserId(owner.db);
const agentDb = connectAgent(inject("databaseUrl"), userId);
const ids = { checking: "", savings: "" };

async function seed() {
  const { db } = owner;
  await db.execute(sql`TRUNCATE item, security CASCADE`);
  const [it] = await db
    .insert(item)
    .values({ userId, source: "plaid", plaidItemId: "chase-item", institutionName: "Chase" })
    .returning();
  if (!it) throw new Error("no item");
  const rows = await db
    .insert(account)
    .values([
      { userId, itemId: it.id, name: "Total Checking", type: "depository", subtype: "checking" },
      { userId, itemId: it.id, name: "Chase Savings", type: "depository", subtype: "savings" },
      { userId, itemId: it.id, name: "Card", type: "credit", subtype: "credit card" },
      { userId, itemId: it.id, name: "CD", type: "depository", subtype: "cd" },
      {
        userId,
        itemId: it.id,
        name: "Euro Savings",
        type: "depository",
        subtype: "savings",
        currency: "EUR",
      },
    ])
    .returning();
  const [checking, savings, card, cd, euro] = rows.map((a) => a.id) as string[] as [
    string,
    string,
    string,
    string,
    string,
  ];
  Object.assign(ids, { checking, savings });

  const at = (s: string) => new Date(s);
  await db.insert(balanceSnapshot).values([
    // Older than 90 days: left out of the average.
    { userId, accountId: checking, current: "100000.00", asOf: at("2026-01-01T12:00:00Z") },
    { userId, accountId: checking, current: "6000.00", asOf: at("2026-10-28T12:00:00Z") },
    // Two snapshots on one day: the later one counts.
    { userId, accountId: checking, current: "5000.00", asOf: at("2026-10-29T08:00:00Z") },
    { userId, accountId: checking, current: "7000.00", asOf: at("2026-10-29T20:00:00Z") },
    { userId, accountId: savings, current: "10000.00", asOf: at("2026-10-30T10:00:00Z") },
    { userId, accountId: card, current: "900.00", asOf: at("2026-10-30T10:00:00Z") },
    { userId, accountId: cd, current: "20000.00", asOf: at("2026-10-30T10:00:00Z") },
    { userId, accountId: euro, current: "3000.00", asOf: at("2026-10-30T10:00:00Z") },
  ]);

  let n = 0;
  const t = (
    accountId: string,
    date: string,
    amount: string,
    categoryDetailed: string,
    extra: Partial<typeof transaction.$inferInsert> = {},
  ) => ({
    userId,
    accountId,
    plaidTransactionId: `t${++n}`,
    date,
    amount,
    name: "x",
    categoryPrimary: categoryDetailed.split("_")[0] ?? null,
    categoryDetailed,
    pending: false,
    ...extra,
  });
  await db.insert(transaction).values([
    // Checking: a year and more of history, two monthly fees and an overdraft in the window.
    t(checking, "2025-09-01", "-2000.00", "INCOME_WAGES"),
    t(checking, "2025-10-15", "15.00", "BANK_FEES_OTHER_BANK_FEES"), // before the window
    t(checking, "2026-03-01", "15.00", "BANK_FEES_OTHER_BANK_FEES"),
    t(checking, "2026-04-01", "15.00", "BANK_FEES_OTHER_BANK_FEES"),
    t(checking, "2026-05-01", "35.00", "BANK_FEES_OVERDRAFT_FEES"),
    t(checking, "2026-06-01", "15.00", "BANK_FEES_OTHER_BANK_FEES", {
      removedAt: at("2026-06-02T00:00:00Z"),
    }),
    t(checking, "2026-07-01", "2.50", "BANK_FEES_ATM_FEES"), // not something switching avoids
    // Savings: 180 days of history, six interest credits of 0.50, one still pending.
    ...["05-04", "05-31", "06-30", "07-31", "08-31", "09-30"].map((d) =>
      t(savings, `2026-${d}`, "-0.50", "INCOME_INTEREST_EARNED"),
    ),
    t(savings, "2026-10-30", "-0.50", "INCOME_INTEREST_EARNED", { pending: true }),
  ]);
}

let client: Client;

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

async function compare(): Promise<Comparison> {
  const res = await client.callTool({ name: "compare_products", arguments: {} });
  const [first] = res.content as { text: string }[];
  if (res.isError) throw new Error(first?.text);
  return JSON.parse(first?.text ?? "null");
}

describe("compare_products", () => {
  it("is a read-only tool", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "compare_products");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it("observes the checking account's fees and ranks better products by annual gain", async () => {
    const r = await compare();
    const checking = r.accounts.find((a) => a.account_id === ids.checking);
    expect(checking).toMatchObject({
      // Its transactions cover the last 90 days, so every day is rebuilt from the latest balance
      // (7000, none posted since August) instead of averaging the two days with snapshots.
      balance: "7000.00",
      balance_basis: "average of the last 90 days' balances, rebuilt from transactions",
      current: {
        annual_interest: "0.00",
        annual_fees: "65.00",
        effective_apy: "0.00",
        observed_days: 365,
      },
    });
    expect(
      checking?.alternatives.map((a) => [
        a.product_id,
        a.apy,
        a.annual_gain,
        a.annual_gain_without_conditions,
        a.stale,
      ]),
    ).toEqual([
      // 7000 x 4% + the 65 in fees it doesn't charge.
      ["hy-savings", "4.00", "345.00", "100.00", false],
      // 7000 x 2% - 60 monthly fees - the 35 overdraft it would also charge + 65.
      ["fee-checking", "2.00", "110.00", "110.00", true],
      ["tiered-checking", "0.10", "72.00", "72.00", false],
    ]);
    expect(checking?.alternatives[0]?.requires).toBe("direct deposit");
  });

  it("annualizes interest from a shorter history and leaves out pending credits", async () => {
    const r = await compare();
    const savings = r.accounts.find((a) => a.account_id === ids.savings);
    expect(savings?.current).toMatchObject({
      annual_interest: "6.08", // 3.00 over 180 days
      effective_apy: "0.06",
      observed_days: 180,
    });
    // Savings accounts are only compared with savings and cash management products.
    expect(savings?.alternatives.map((a) => [a.product_id, a.annual_gain])).toEqual([
      // Rebuilt: 9999.00 until the 08-31 credit, 9999.50 until 09-30, then 10000, averaging
      // 9999.51; x 4% - 6.08 already earned.
      ["hy-savings", "393.90"],
    ]);
  });

  it("totals the best gain per account and flags stale rates", async () => {
    const r = await compare();
    expect(r.annual_loss).toBe("738.90");
    expect(r.monthly_loss).toBe("61.58");
    expect(r.annual_loss_without_conditions).toBe("153.91");
    expect(r.accounts.map((a) => a.account_name).sort()).toEqual([
      "Chase Savings",
      "Euro Savings",
      "Total Checking",
    ]);
    expect(r.accounts.find((a) => a.account_name === "Euro Savings")?.skipped).toMatch(/US dollar/);
    expect(r.warnings).toEqual([expect.stringMatching(/^Fee Checking was last verified 90 days/)]);
  });

  it("is on the admin API", async () => {
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
      products: { loadCatalog: async () => catalog, today: () => TODAY },
    });
    expect((await app.request("/api/products")).status).toBe(401);
    const basic = `Basic ${Buffer.from(`luka:${ADMIN}`).toString("base64")}`;
    const res = await app.request("/api/products", { headers: { Authorization: basic } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Comparison).annual_loss).toBe("738.90");
  });
});

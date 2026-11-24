import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { TokenCipher } from "../src/crypto/tokenCipher.js";
import { connect } from "../src/db/client.js";
import {
  account,
  appUser,
  balanceSnapshot,
  holding,
  item,
  itemSecret,
  liability,
  security,
  transaction,
} from "../src/db/schema.js";
import { connectAgent, connectProposer } from "../src/mcp/agentDb.js";
import { createTidysumMcpServer } from "../src/mcp/server.js";
import { PlaidWebhookVerifier } from "../src/plaid/webhookVerifier.js";
import { parsePolicy } from "../src/policy/policy.js";
import { createProposal } from "../src/policy/proposals.js";
import { readSnapshot } from "../src/policy/snapshot.js";
import { activatePolicy } from "../src/policy/store.js";
import { readAllocation, showsInvestmentAmounts } from "../src/portfolio/allocation.js";
import {
  listManualHoldings,
  removeManualHolding,
  setManualHolding,
} from "../src/portfolio/manualHoldings.js";
import { loadSecurityCatalogFile } from "../src/portfolio/securityCatalog.js";
import { createApp } from "../src/server/app.js";
import { SyncScheduler } from "../src/sync/scheduler.js";
import { createUser, setShowInvestmentAmounts } from "../src/users.js";
import { FakePlaid } from "./fakePlaid.js";
import { ownerUserId } from "./users.js";

const owner = connect(inject("databaseUrl"));
const userId = await ownerUserId(owner.db);
const agentDb = connectAgent(inject("databaseUrl"), userId);
const proposer = connectProposer(inject("databaseUrl"), userId);
const policy = parsePolicy({
  version: 1,
  cash: { buffer: { amount: "500" }, tolerance: "100" },
  limits: { max_action_amount: "5000" },
});
let client: Client;
const ids = { checking: "", card: "", brokerage: "" };

async function seed() {
  const { db } = owner;
  await db.execute(sql`TRUNCATE item, security CASCADE`);
  const [it] = await db
    .insert(item)
    .values({
      userId,
      source: "plaid",
      plaidItemId: "plaid-item-1",
      institutionName: "First Platypus Bank",
      transactionsCursor: "secret-cursor",
    })
    .returning();
  if (!it) throw new Error("no item");
  await db.insert(itemSecret).values({
    itemId: it.id,
    accessTokenCiphertext: Buffer.from("ciphertext"),
    keyVersion: 1,
  });
  const accounts = await db
    .insert(account)
    .values([
      {
        userId,
        itemId: it.id,
        name: "Checking",
        type: "depository",
        subtype: "checking",
        mask: "0000",
      },
      { userId, itemId: it.id, name: "Card", type: "credit", subtype: "credit card", mask: "3333" },
      { userId, itemId: it.id, name: "Brokerage", type: "investment", subtype: "brokerage" },
    ])
    .returning();
  const [checking, card, brokerage] = accounts.map((a) => a.id) as [string, string, string];
  Object.assign(ids, { checking, card, brokerage });

  const at = (s: string) => new Date(s);
  await db.insert(balanceSnapshot).values([
    {
      userId,
      accountId: checking,
      current: "1000.00",
      currency: "USD",
      asOf: at("2026-01-15T12:00:00Z"),
    },
    {
      userId,
      accountId: checking,
      current: "1500.00",
      currency: "USD",
      asOf: at("2026-02-15T12:00:00Z"),
    },
    {
      userId,
      accountId: card,
      current: "200.00",
      currency: "USD",
      asOf: at("2026-01-15T12:00:00Z"),
    },
    {
      userId,
      accountId: brokerage,
      current: "5000.00",
      currency: "USD",
      asOf: at("2026-02-01T12:00:00Z"),
    },
  ]);

  const t = (
    accountId: string,
    id: string,
    date: string,
    amount: string,
    name: string,
    categoryPrimary: string,
    extra: Partial<typeof transaction.$inferInsert> = {},
  ) => ({
    userId,
    accountId,
    plaidTransactionId: id,
    date,
    amount,
    currency: "USD",
    name,
    categoryPrimary,
    pending: false,
    ...extra,
  });
  await db.insert(transaction).values([
    t(checking, "t1", "2026-01-10", "-2000.00", "PAYROLL ACME", "INCOME"),
    t(checking, "t2", "2026-01-12", "45.50", "Blue Bottle", "FOOD_AND_DRINK", {
      merchantName: "Blue Bottle Coffee",
    }),
    t(card, "t3", "2026-01-20", "80.10", "Target", "GENERAL_MERCHANDISE"),
    t(checking, "t4", "2026-02-03", "300.00", "CARD PAYMENT", "LOAN_PAYMENTS", {
      categoryDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
    }),
    t(card, "t5", "2026-02-04", "-300.00", "Payment thank you", "TRANSFER_IN"),
    t(checking, "t6", "2026-02-05", "12.25", "Blue Bottle pending", "FOOD_AND_DRINK", {
      pending: true,
    }),
    t(checking, "t7", "2026-02-06", "99.99", "Removed", "FOOD_AND_DRINK", {
      removedAt: at("2026-02-07T00:00:00Z"),
    }),
  ]);

  await db.insert(security).values({ id: "sec-vti", name: "Vanguard Total", tickerSymbol: "VTI" });
  await db.insert(holding).values({
    userId,
    accountId: brokerage,
    securityId: "sec-vti",
    quantity: "10.5",
    institutionPrice: "300.00",
    institutionValue: "3150.00",
    costBasis: "2500.00",
    currency: "USD",
    asOf: at("2026-02-01T12:00:00Z"),
  });
  await db.insert(liability).values({
    userId,
    accountId: card,
    kind: "credit",
    aprPercentage: "24.99",
    lastStatementBalance: "180.00",
    minimumPayment: "25.00",
    nextPaymentDueDate: "2026-03-01",
    isOverdue: false,
    asOf: at("2026-02-01T12:00:00Z"),
  });
  await activatePolicy(db, userId, policy);
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const [first] = res.content as { type: string; text: string }[];
  if (res.isError) throw new Error(first?.text);
  return JSON.parse(first?.text ?? "null");
}

beforeAll(async () => {
  await seed();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createTidysumMcpServer(agentDb, {
    proposer,
    loadPolicy: async () => policy,
    today: () => "2026-03-01",
  }).connect(serverTransport);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await agentDb.end();
  await proposer.end();
  await owner.close();
});

describe("agent database session", () => {
  it("runs as tidysum_agent, read-only", async () => {
    const { rows } = await agentDb.query(
      "select current_user as role, current_setting('transaction_read_only') as ro",
    );
    expect(rows[0]).toEqual({ role: "tidysum_agent", ro: "on" });
  });

  it("cannot read Plaid secrets or cursors", async () => {
    await expect(agentDb.query("select * from item_secret")).rejects.toThrow(/permission denied/);
    await expect(agentDb.query("select transactions_cursor from item")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("cannot read the user's phone number", async () => {
    await expect(agentDb.query("select phone_number from app_user")).rejects.toThrow(
      /permission denied/,
    );
    const { rows } = await agentDb.query("select investing_enabled from app_user");
    expect(rows).toHaveLength(1);
  });

  it("cannot write", async () => {
    await expect(
      agentDb.query("update transaction set amount = 0 where plaid_transaction_id = 't1'"),
    ).rejects.toThrow(/read-only transaction|permission denied/);
  });
});

describe("MCP tools", () => {
  it("lists read-only tools, plus proposals and reports on approved actions as the writes", async () => {
    const writes = [
      "create_proposal",
      "finish_action",
      "report_step",
      "schedule_action",
      "start_action",
      "stop_action",
      "pause_action",
    ];
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cash_flow_summary",
      "check_policy",
      "create_proposal",
      "croatia_owner_check",
      "finish_action",
      "get_action",
      "get_holdings",
      "get_liabilities",
      "get_plan",
      "get_policy",
      "list_accounts",
      "list_actions",
      "list_proposals",
      "list_styles",
      "net_worth_history",
      "pause_action",
      "query_transactions",
      "report_step",
      "schedule_action",
      "start_action",
      "stop_action",
    ]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(!writes.includes(t.name));
    }
  });

  it("list_accounts returns each account's latest balance", async () => {
    const { accounts } = await call("list_accounts");
    const checking = accounts.find((a: { name: string }) => a.name === "Checking");
    expect(checking).toMatchObject({
      institution_name: "First Platypus Bank",
      item_status: "active",
      current_balance: "1500.0000",
      mask: "0000",
    });
    expect(checking.balance_as_of).toMatch(/^2026-02-15 12:00:00/);
    expect(JSON.stringify(accounts)).not.toContain("secret-cursor");
  });

  it("query_transactions filters, hides removed rows and pages", async () => {
    const all = await call("query_transactions", {});
    expect(all.transactions.map((t: { name: string }) => t.name)).not.toContain("Removed");
    expect(all.transactions).toHaveLength(6);

    const coffee = await call("query_transactions", { search: "bottle", include_pending: false });
    expect(coffee.transactions).toEqual([
      expect.objectContaining({ date: "2026-01-12", amount: "45.5000", account_name: "Checking" }),
    ]);

    const jan = await call("query_transactions", { from: "2026-01-01", to: "2026-01-31" });
    expect(jan.transactions.map((t: { date: string }) => t.date)).toEqual([
      "2026-01-20",
      "2026-01-12",
      "2026-01-10",
    ]);

    const big = await call("query_transactions", {
      min_amount: "100",
      account_ids: [ids.checking],
    });
    expect(big.transactions.map((t: { name: string }) => t.name)).toEqual(["CARD PAYMENT"]);

    const p1 = await call("query_transactions", { limit: 4 });
    expect(p1.transactions).toHaveLength(4);
    expect(p1.next_offset).toBe(4);
    const p2 = await call("query_transactions", { limit: 4, offset: 4 });
    expect(p2.transactions).toHaveLength(2);
    expect(p2.next_offset).toBeNull();
  });

  it("treats search text as a literal, not a LIKE pattern", async () => {
    const r = await call("query_transactions", { search: "%" });
    expect(r.transactions).toHaveLength(0);
  });

  it("rejects malformed amounts and dates", async () => {
    await expect(call("query_transactions", { min_amount: "1e3" })).rejects.toThrow();
    await expect(call("query_transactions", { from: "Jan 1" })).rejects.toThrow();
  });

  it("cash_flow_summary leaves out transfers, card payments, pending and removed rows", async () => {
    const r = await call("cash_flow_summary", { from: "2026-01-01", to: "2026-02-28" });
    expect(r.groups).toEqual([
      {
        key: "2026-01",
        currency: "USD",
        inflow: "2000.0000",
        outflow: "125.6000",
        net: "1874.4000",
        transaction_count: 3,
      },
    ]);
    expect(r.totals).toEqual([expect.objectContaining({ net: "1874.4000" })]);

    const withTransfers = await call("cash_flow_summary", {
      from: "2026-02-01",
      to: "2026-02-28",
      exclude_transfers: false,
    });
    expect(withTransfers.groups).toEqual([
      expect.objectContaining({ key: "2026-02", inflow: "300.0000", outflow: "300.0000" }),
    ]);

    const byCategory = await call("cash_flow_summary", {
      from: "2026-01-01",
      to: "2026-02-28",
      group_by: "category",
    });
    expect(byCategory.groups.map((g: { key: string }) => g.key)).toEqual([
      "FOOD_AND_DRINK",
      "GENERAL_MERCHANDISE",
      "INCOME",
    ]);
  });

  it("net_worth_history uses the latest snapshot on or before each date", async () => {
    const r = await call("net_worth_history", { from: "2026-01-01", to: "2026-03-01" });
    expect(r.points).toEqual([
      {
        on_date: "2026-02-01",
        currency: "USD",
        assets: "6000.0000",
        liabilities: "200.0000",
        net_worth: "5800.0000",
        account_count: 3,
      },
      {
        on_date: "2026-03-01",
        currency: "USD",
        assets: "6500.0000",
        liabilities: "200.0000",
        net_worth: "6300.0000",
        account_count: 3,
      },
    ]);
  });

  it("net_worth_history caps daily ranges", async () => {
    await expect(
      call("net_worth_history", { from: "2020-01-01", to: "2026-01-01", interval: "day" }),
    ).rejects.toThrow(/limited/);
  });

  it("get_holdings and get_liabilities", async () => {
    const h = await call("get_holdings");
    expect(h.holdings).toEqual([
      expect.objectContaining({ ticker_symbol: "VTI", quantity: "10.5000000000" }),
    ]);
    expect(h.totals).toEqual([
      expect.objectContaining({ account_name: "Brokerage", total_value: "3150.0000" }),
    ]);
    const l = await call("get_liabilities");
    expect(l.liabilities).toEqual([
      expect.objectContaining({
        account_name: "Card",
        apr_percentage: "24.9900",
        current_balance: "200.0000",
        next_payment_due_date: "2026-03-01",
      }),
    ]);
  });
});

describe("policy and proposals", () => {
  it("check_policy reports cash above the buffer from synced balances", async () => {
    const r = await call("check_policy");
    expect(r.policy_version).toBe(policy.versionId);
    const cash = r.findings.find((f: { check: string }) => f.check === "cash_buffer");
    expect(cash).toMatchObject({ status: "action", amount: "1000.00" });
    expect(cash.numbers.cash_accounts).toEqual([
      expect.objectContaining({ id: ids.checking, spendable: "1500.00" }),
    ]);
  });

  it("the snapshot counts card interest actually charged over the last year", async () => {
    const charge = (id: string, date: string) => ({
      userId,
      accountId: ids.card,
      plaidTransactionId: id,
      date,
      amount: "4.12",
      name: "INTEREST CHARGE",
      categoryPrimary: "BANK_FEES",
      categoryDetailed: "BANK_FEES_INTEREST_CHARGE",
      pending: false,
    });
    await owner.db
      .insert(transaction)
      .values([charge("i1", "2026-02-10"), charge("i2", "2024-12-01")]);
    try {
      const s = await readSnapshot(agentDb, "2026-03-01");
      expect(s.liabilities[0]?.interest_charged_365d).toBe("4.1200");
      expect(s.investing_enabled).toBe(true);
    } finally {
      await owner.db
        .update(transaction)
        .set({ removedAt: new Date() })
        .where(sql`plaid_transaction_id in ('i1', 'i2')`);
    }
  });

  it("reads the allocation through the agent role, in percentages", async () => {
    const s = await readSnapshot(agentDb, "2026-03-01");
    expect(s.holdings[0]).toMatchObject({ security_id: "sec-vti", cost_basis: "2500.0000" });
    // The test policy has no target allocation.
    expect(await readAllocation(agentDb, undefined, "2026-03-01")).toEqual({
      state: "no_target",
      as_of: "2026-03-01",
      show_amounts: false,
    });
  });

  it("lets the agent read whether the user turned investment amounts on", async () => {
    await setShowInvestmentAmounts(owner.db, userId, true);
    try {
      expect(await readAllocation(agentDb, undefined, "2026-03-01")).toMatchObject({
        show_amounts: true,
      });
    } finally {
      await setShowInvestmentAmounts(owner.db, userId, false);
    }
    expect(await showsInvestmentAmounts(agentDb)).toBe(false);
  });

  it("keeps hand-entered holdings per user, readable by the agent", async () => {
    const catalog = await loadSecurityCatalogFile("catalog/securities.json");
    const t = {
      name: "TreasuryDirect",
      assetClass: "bonds",
      value: "30000.00",
      asOf: "2026-03-01",
    };
    await expect(
      setManualHolding(owner.db, catalog, userId, { ...t, assetClass: "beans" }),
    ).rejects.toThrow(/unknown asset class/);
    await expect(
      setManualHolding(owner.db, catalog, userId, { ...t, value: "30,000" }),
    ).rejects.toThrow(/decimal/);
    await setManualHolding(owner.db, catalog, userId, t);
    // Setting it again updates the one row.
    await setManualHolding(owner.db, catalog, userId, { ...t, value: "30100.50" });
    try {
      const s = await readSnapshot(agentDb, "2026-03-01");
      expect(s.manual_holdings).toEqual([
        expect.objectContaining({
          name: "TreasuryDirect",
          asset_class: "bonds",
          value: "30100.5000",
          as_of: "2026-03-01",
        }),
      ]);
      expect(await listManualHoldings(owner.db, userId)).toEqual([
        { name: "TreasuryDirect", assetClass: "bonds", asOf: "2026-03-01" },
      ]);
      await expect(agentDb.query("delete from manual_holding")).rejects.toThrow(
        /read-only transaction|permission denied/,
      );
    } finally {
      expect(await removeManualHolding(owner.db, userId, "TreasuryDirect")).toBe(true);
    }
    expect(await removeManualHolding(owner.db, userId, "TreasuryDirect")).toBe(false);
  });

  it("stores a valid proposal with its actions and an audit event", async () => {
    const created = await call("create_proposal", {
      title: "Pay the card",
      rationale: "Card statement is due; cash is 1000 above the buffer.",
      expected_annual_value: "49.98",
      finding_key: "card_statement:x",
      actions: [
        {
          kind: "payment",
          from_account_id: ids.checking,
          to_account_id: ids.card,
          amount: "200.00",
        },
      ],
    });
    expect(created).toMatchObject({
      state: "proposed",
      category: "card",
      validation: { violations: [] },
    });

    const { proposals } = await call("list_proposals", {});
    const p = proposals.find((x: { id: string }) => x.id === created.proposal_id);
    expect(p).toMatchObject({
      title: "Pay the card",
      source: "mcp:test",
      policy_version_id: policy.versionId,
      category: "card",
      expected_annual_value: "49.9800",
      finding_key: "card_statement:x",
    });
    expect(p.actions).toEqual([
      expect.objectContaining({
        kind: "payment",
        from_account: "Checking",
        to_account: "Card",
        amount: "200.0000",
      }),
    ]);
    const audit = await owner.db.execute(
      sql`select actor, event from audit_event where proposal_id = ${created.proposal_id}`,
    );
    expect(audit.rows).toEqual([{ actor: "mcp:test", event: "proposal.created" }]);
    const evidence = await owner.db.execute(
      sql`select data->'evidence' as e from audit_event where proposal_id = ${created.proposal_id}`,
    );
    const e = evidence.rows[0]?.e as { accounts: { id: string }[]; today: string };
    expect(e.today).toBe("2026-03-01");
    expect(e.accounts.map((a) => a.id)).toContain(ids.checking);
  });

  it("stores a proposal that breaks the buffer as blocked, with the reason", async () => {
    const created = await call("create_proposal", {
      title: "Sweep everything",
      rationale: "Move all checking into the brokerage.",
      actions: [
        {
          kind: "transfer",
          from_account_id: ids.checking,
          to_account_id: ids.brokerage,
          amount: "1200",
        },
      ],
    });
    expect(created.state).toBe("blocked");
    expect(created.validation.violations).toEqual([
      expect.stringMatching(/below the 500.00 buffer/),
    ]);
  });

  it("rejects malformed actions before they reach the database", async () => {
    await expect(
      call("create_proposal", {
        title: "Bad",
        rationale: "Trade without a symbol.",
        actions: [{ kind: "trade", from_account_id: ids.brokerage, side: "buy", amount: "10" }],
      }),
    ).rejects.toThrow(/side and symbol/);
    await expect(
      call("create_proposal", {
        title: "Bad",
        rationale: "Negative amount here.",
        actions: [
          { kind: "payment", from_account_id: ids.checking, to_account_id: ids.card, amount: "-5" },
        ],
      }),
    ).rejects.toThrow();
  });

  it("the proposer role can insert but never change or delete", async () => {
    await expect(proposer.query("update proposal set state = 'dismissed'")).rejects.toThrow(
      /permission denied/,
    );
    await expect(proposer.query("delete from audit_event")).rejects.toThrow(/permission denied/);
    await expect(proposer.query("update item set status = 'active'")).rejects.toThrow(
      /permission denied/,
    );
    await expect(proposer.query("select * from item_secret")).rejects.toThrow(/permission denied/);
    await expect(
      agentDb.query("insert into audit_event (actor, event, data) values ('x', 'y', '{}')"),
    ).rejects.toThrow(/read-only|permission denied/);
  });

  it("the audit log is append-only even for the owner", async () => {
    await expect(owner.db.execute(sql`update audit_event set actor = 'x'`)).rejects.toThrow();
    await expect(owner.db.execute(sql`delete from audit_event`)).rejects.toThrow();
  });
});

describe("tenant isolation", () => {
  const tables = [
    "item",
    "account",
    "balance_snapshot",
    "transaction",
    "holding",
    "liability",
    "sync_run",
    "policy_version",
    "proposal",
    "proposal_action",
    "audit_event",
    "card_assignment",
    "deposit_choice",
    "action_order",
    "misallocation",
    "manual_holding",
    "financial_plan",
    "ira_year",
  ];

  async function withOtherUser(fn: (other: string) => Promise<void>) {
    const other = await createUser(owner.db, "Someone else");
    try {
      await fn(other);
    } finally {
      await owner.db.delete(appUser).where(eq(appUser.id, other));
    }
  }

  it("this user's data is there to see", async () => {
    const { rows } = await agentDb.query("select count(*)::int as n from account");
    expect(rows[0]).toEqual({ n: 3 });
  });

  it("another user's agent session sees none of it", async () => {
    await withOtherUser(async (other) => {
      const otherDb = connectAgent(inject("databaseUrl"), other);
      try {
        for (const table of tables) {
          const { rows } = await otherDb.query(`select count(*)::int as n from ${table}`);
          expect(rows[0], table).toEqual({ n: 0 });
        }
        const users = await otherDb.query("select id from app_user");
        expect(users.rows).toEqual([{ id: other }]);
      } finally {
        await otherDb.end();
      }
    });
  });

  it("a session without a user sees nothing", async () => {
    const url = new URL(inject("databaseUrl"));
    url.searchParams.set("options", "-c role=tidysum_agent");
    const anon = new pg.Pool({ connectionString: url.toString(), max: 1 });
    try {
      for (const table of tables) {
        const { rows } = await anon.query(`select count(*)::int as n from ${table}`);
        expect(rows[0], table).toEqual({ n: 0 });
      }
    } finally {
      await anon.end();
    }
  });

  it("another user can't propose moving this user's money", async () => {
    await withOtherUser(async (other) => {
      await activatePolicy(owner.db, other, policy);
      const otherProposer = connectProposer(inject("databaseUrl"), other);
      try {
        await expect(
          createProposal(
            otherProposer,
            policy,
            {
              title: "Take it",
              rationale: "Not my account.",
              actions: [
                {
                  kind: "transfer",
                  from_account_id: ids.checking,
                  to_account_id: ids.brokerage,
                  amount: "10",
                },
              ],
            },
            "mcp:other",
            "2026-03-01",
          ),
        ).rejects.toThrow(/foreign key/);
        await expect(
          otherProposer.query(
            `insert into audit_event (user_id, actor, event, data) values ($1, 'x', 'y', '{}')`,
            [userId],
          ),
        ).rejects.toThrow(/row-level security/);
      } finally {
        await otherProposer.end();
      }
    });
  });

  it("user ids in the connection options are validated", () => {
    expect(() => connectAgent(inject("databaseUrl"), "x -c role=postgres")).toThrow(
      /not a user id/,
    );
  });
});

describe("HTTP /mcp", () => {
  const ADMIN = "admin password that is long enough 0123";
  const MCP = "agent token that is long enough 0123456";
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
    mcp: { token: MCP },
  });
  const rpc = (body: unknown, authorization?: string) =>
    app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(body),
    });
  const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };

  it("needs the MCP token, and the admin password doesn't work", async () => {
    expect((await rpc(listTools)).status).toBe(401);
    expect((await rpc(listTools, "Bearer wrong")).status).toBe(401);
    const basic = `Basic ${Buffer.from(`owner:${ADMIN}`).toString("base64")}`;
    expect((await rpc(listTools, basic)).status).toBe(401);
  });

  it("the MCP token doesn't open the admin API", async () => {
    const res = await app.request("/api/items", { headers: { Authorization: `Bearer ${MCP}` } });
    expect(res.status).toBe(401);
  });

  it("serves tools to an authenticated agent", async () => {
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_accounts", arguments: {} },
      },
      `Bearer ${MCP}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    const { accounts } = JSON.parse(body.result.content[0]?.text ?? "{}");
    expect(accounts).toHaveLength(3);
  });

  it("lists proposals on the admin API and dismisses one, with an audit event", async () => {
    const basic = `Basic ${Buffer.from(`owner:${ADMIN}`).toString("base64")}`;
    const list = await app.request("/api/proposals", { headers: { Authorization: basic } });
    const { proposals } = (await list.json()) as { proposals: { id: string; state: string }[] };
    const open = proposals.find((p) => p.state === "proposed");
    if (!open) throw new Error("no open proposal");
    const post = (path: string) =>
      app.request(path, {
        method: "POST",
        headers: {
          Authorization: basic,
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    expect((await post(`/api/proposals/${open.id}/dismiss`)).status).toBe(200);
    expect((await post(`/api/proposals/${open.id}/dismiss`)).status).toBe(404);
    const audit = await owner.db.execute(
      sql`select actor, event from audit_event where proposal_id = ${open.id} order by id`,
    );
    expect(audit.rows.map((r) => r.event)).toEqual(["proposal.created", "proposal.dismissed"]);
  });

  describe("approving a proposal on the admin API", () => {
    const basic = `Basic ${Buffer.from(`owner:${ADMIN}`).toString("base64")}`;
    const post = (path: string) =>
      app.request(path, {
        method: "POST",
        headers: {
          Authorization: basic,
          Origin: "http://localhost",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    const propose = (amount: string) =>
      call("create_proposal", {
        title: "Move cash above the buffer",
        rationale: "Checking holds 1000 above the 500 buffer.",
        actions: [
          {
            kind: "transfer",
            from_account_id: ids.checking,
            to_account_id: ids.brokerage,
            amount,
          },
        ],
      });
    const events = async (id: string) =>
      (
        await owner.db.execute(
          sql`select event from audit_event where proposal_id = ${id} order by id`,
        )
      ).rows.map((r) => r.event);

    it("re-checks it, records the approval with evidence, and moves nothing", async () => {
      const { proposal_id: id } = await propose("400");
      const res = await post(`/api/proposals/${id}/approve`);
      expect(res.status).toBe(200);
      expect((await post(`/api/proposals/${id}/approve`)).status).toBe(404);
      const [row] = (
        await owner.db.execute(sql`select state, decided_at from proposal where id = ${id}`)
      ).rows;
      expect(row?.state).toBe("approved");
      expect(row?.decided_at).not.toBeNull();
      expect(await events(id)).toEqual(["proposal.created", "proposal.approved"]);
      const [ev] = (
        await owner.db.execute(
          sql`select data from audit_event where proposal_id = ${id} and event = 'proposal.approved'`,
        )
      ).rows as { data: { policy_version: string; evidence: { accounts: unknown[] } } }[];
      expect(ev?.data.policy_version).toBe(policy.versionId);
      expect(ev?.data.evidence.accounts.length).toBeGreaterThan(0);
      // Taking it back is a dismissal.
      expect((await post(`/api/proposals/${id}/dismiss`)).status).toBe(200);
    });

    it("refuses a blocked proposal", async () => {
      const { proposal_id: id, state } = await propose("1200");
      expect(state).toBe("blocked");
      expect((await post(`/api/proposals/${id}/approve`)).status).toBe(404);
    });

    it("refuses one the rules block now, and keeps it open", async () => {
      const { proposal_id: id, state } = await propose("900");
      expect(state).toBe("proposed");
      // Checking drops after the proposal was made: 900 would now cut into the buffer.
      const [b] = await owner.db
        .insert(balanceSnapshot)
        .values({
          userId,
          accountId: ids.checking,
          current: "1000.00",
          currency: "USD",
          asOf: new Date("2026-02-20T12:00:00Z"),
        })
        .returning();
      try {
        const res = await post(`/api/proposals/${id}/approve`);
        expect(res.status).toBe(409);
        expect(((await res.json()) as { error: string }).error).toMatch(/buffer/);
        const [row] = (await owner.db.execute(sql`select state from proposal where id = ${id}`))
          .rows;
        expect(row?.state).toBe("proposed");
        expect(await events(id)).toEqual(["proposal.created", "proposal.approval_refused"]);
      } finally {
        if (b) await owner.db.delete(balanceSnapshot).where(eq(balanceSnapshot.id, b.id));
      }
    });
  });

  it("is off unless configured", async () => {
    const off = createApp({
      db: owner.db,
      plaid,
      cipher,
      scheduler: new SyncScheduler(owner.db, plaid, cipher),
      verifier: new PlaidWebhookVerifier(plaid),
      adminToken: ADMIN,
      daysRequested: 730,
      userId,
      agentDb,
    });
    const res = await off.request("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${MCP}` },
    });
    expect(res.status).toBe(401);
  });
});

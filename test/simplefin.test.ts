import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, inject, it } from "vitest";
import { TokenCipher } from "../src/crypto/tokenCipher.js";
import { connect } from "../src/db/client.js";
import {
  account,
  appUser,
  balanceSnapshot,
  holding,
  item,
  security,
  transaction,
} from "../src/db/schema.js";
import { connectAgent } from "../src/mcp/agentDb.js";
import { PlaidWebhookVerifier } from "../src/plaid/webhookVerifier.js";
import { createApp } from "../src/server/app.js";
import { categorize } from "../src/simplefin/categories.js";
import {
  DAILY_REQUESTS,
  type SfAccount,
  SimpleFinClient,
  SimpleFinError,
} from "../src/simplefin/client.js";
import {
  kindOf,
  mapAccount,
  mapHolding,
  mapTransactions,
  SimpleFinGateway,
  withSimpleFin,
} from "../src/simplefin/gateway.js";
import { SyncScheduler } from "../src/sync/scheduler.js";
import { syncItem } from "../src/sync/syncItem.js";
import { createUser } from "../src/users.js";
import { FakePlaid } from "./fakePlaid.js";

const NOW = new Date("2026-11-20T12:00:00Z");
const unix = (iso: string) => Date.parse(iso) / 1000;
const acct = (over: Partial<SfAccount>): SfAccount => ({
  id: "a1",
  name: "Account",
  currency: "USD",
  balance: "0",
  "balance-date": unix("2026-11-20T00:00:00Z"),
  ...over,
});

describe("SimpleFIN shapes", () => {
  it("tells account kinds from names, holdings and the balance's sign", () => {
    expect(kindOf(acct({ name: "TOTAL CHECKING (1234)" }))).toEqual(["depository", "checking"]);
    expect(kindOf(acct({ name: "Online Savings" }))).toEqual(["depository", "savings"]);
    expect(kindOf(acct({ name: "Sapphire Preferred" }))).toEqual(["credit", "credit card"]);
    expect(kindOf(acct({ name: "Roth IRA" }))).toEqual(["investment", "roth"]);
    expect(kindOf(acct({ name: "401(k) Savings Plan" }))).toEqual(["investment", "401k"]);
    expect(
      kindOf(acct({ name: "Individual", holdings: [{ symbol: "VTI", shares: "1" }] })),
    ).toEqual(["investment", "brokerage"]);
    // No hint in the name: debt shows below zero.
    expect(kindOf(acct({ name: "Everyday", balance: "-52.10" }))).toEqual([
      "credit",
      "credit card",
    ]);
    expect(kindOf(acct({ name: "Everyday", balance: "52.10" }))).toEqual(["depository", "other"]);
  });

  it("counts a card's debt above zero and keeps the last four digits", () => {
    const card = mapAccount(
      "item-1",
      acct({ id: "c1", name: "Freedom Unlimited (4321)", balance: "-310.20" }),
    );
    expect(card).toMatchObject({
      name: "Freedom Unlimited (4321)",
      type: "credit",
      mask: "4321",
      currency: "USD",
      balances: { current: "310.2", available: null },
    });
    const checking = mapAccount(
      "item-1",
      acct({ id: "k1", name: "Checking", balance: "1250.00", "available-balance": "1200.50" }),
    );
    expect(checking.balances).toEqual({ current: "1250", available: "1200.5", limit: null });
    // Ids are stable per item and differ between items.
    expect(mapAccount("item-1", acct({ id: "k1" })).accountId).toBe(checking.accountId);
    expect(mapAccount("item-2", acct({ id: "k1" })).accountId).not.toBe(checking.accountId);
  });

  it("books money out as positive, skips pending, and categorises by merchant code", () => {
    const a = acct({
      transactions: [
        {
          id: "t1",
          posted: unix("2026-11-18T12:00:00Z"),
          amount: "-82.40",
          description: "WHOLE FOODS #123",
          payee: "Whole Foods",
          mcc: "5411",
        },
        { id: "t2", posted: 0, amount: "-5.00", description: "PENDING", pending: true },
        {
          id: "t3",
          posted: unix("2026-11-01T12:00:00Z"),
          amount: "3000.00",
          description: "ACME CORP PAYROLL",
        },
        {
          id: "t4",
          posted: unix("2026-11-02T12:00:00Z"),
          amount: "-41.00",
          description: "UNITED 0162",
          mcc: "3000",
        },
      ],
    });
    const rows = mapTransactions("sf:acct", a, "credit");
    expect(rows.map((r) => [r.date, r.amount, r.merchantName, r.categoryDetailed])).toEqual([
      ["2026-11-18", "82.4", "Whole Foods", "FOOD_AND_DRINK_GROCERIES"],
      ["2026-11-01", "-3000", null, "INCOME_WAGES"],
      ["2026-11-02", "41", null, "TRAVEL_FLIGHTS"],
    ]);
    expect(rows[2]?.categoryPrimary).toBe("TRAVEL");
    expect(mapTransactions("sf:acct", a, "credit")[0]?.transactionId).toBe(rows[0]?.transactionId);
  });

  it("recognises money that isn't spending: card payments, interest and fees", () => {
    const c = (text: string, out: boolean, accountType = "depository", mcc?: string) =>
      categorize({ text, out, accountType, mcc })?.detailed ?? null;
    expect(c("CHASE CREDIT CRD AUTOPAY", true)).toBe("LOAN_PAYMENTS_CREDIT_CARD_PAYMENT");
    expect(c("AUTOMATIC PAYMENT - THANK YOU", false, "credit")).toBe(
      "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
    );
    expect(c("Interest Paid", false)).toBe("INCOME_INTEREST_EARNED");
    expect(c("PURCHASE INTEREST CHARGE", true, "credit")).toBe("BANK_FEES_INTEREST_CHARGE");
    expect(c("FOREIGN TRANSACTION FEE", true, "credit")).toBe("BANK_FEES_FOREIGN_TRANSACTION_FEES");
    expect(c("MONTHLY SERVICE FEE", true)).toBe("BANK_FEES_OTHER_BANK_FEES");
    expect(c("ONLINE TRANSFER TO SAV 9876", true)).toBe("TRANSFER_OUT_ACCOUNT_TRANSFER");
    expect(c("SHELL OIL 5741", true, "credit", "5542")).toBe("TRANSPORTATION_GAS");
    // Unclear stays unclear.
    expect(c("AMAZON MKTPL", true, "credit")).toBeNull();
  });

  it("reads holdings with a price per share and a shared security id", () => {
    const m = mapHolding(
      "sf:acct",
      {
        symbol: "vti",
        description: "Vanguard Total Stock Market ETF",
        shares: "10.5",
        market_value: "3150.00",
        cost_basis: "2100.00",
        currency: "USD",
      },
      "2026-11-20",
      "USD",
    );
    expect(m?.holding).toMatchObject({
      securityId: "sf:VTI",
      quantity: "10.5",
      institutionPrice: "300",
      institutionValue: "3150",
      costBasis: "2100",
    });
    expect(m?.security).toMatchObject({ tickerSymbol: "VTI", type: null, closePrice: "300" });
    const cash = mapHolding(
      "sf:acct",
      { symbol: "SPAXX", shares: "5", market_value: "5" },
      "2026-11-20",
      "USD",
    );
    expect(cash?.security).toMatchObject({ type: "cash", isCashEquivalent: true });
  });
});

/** A small SimpleFIN Bridge: two banks behind one access URL, a third added later. */
function fakeBridge() {
  const requests: URL[] = [];
  let claimed = false;
  const errlist: { code: string; msg: string; conn_id?: string }[] = [];
  const connections = [
    { conn_id: "CON-CHASE", name: "Chase - Jill", org_id: "chase.com", org_name: "Chase" },
    { conn_id: "CON-VG", name: "Vanguard", org_id: "vanguard.com", org_name: "Vanguard" },
  ];
  const day = (iso: string) => unix(`${iso}T12:00:00Z`);
  const accounts: SfAccount[] = [
    acct({
      id: "chk",
      name: "TOTAL CHECKING (1111)",
      conn_id: "CON-CHASE",
      balance: "5200.00",
      transactions: [
        { id: "c1", posted: day("2026-11-15"), amount: "-1200.00", description: "RENT" },
        { id: "c2", posted: day("2026-03-01"), amount: "-60.00", description: "OLD BILL" },
      ],
    }),
    acct({
      id: "cc",
      name: "Sapphire Preferred (2222)",
      conn_id: "CON-CHASE",
      balance: "-845.10",
      transactions: [
        {
          id: "s1",
          posted: day("2026-11-10"),
          amount: "-95.00",
          description: "TRADER JOE'S",
          mcc: "5411",
        },
      ],
    }),
    acct({
      id: "brk",
      name: "Brokerage Account",
      conn_id: "CON-VG",
      balance: "10000.00",
      holdings: [
        {
          symbol: "VTI",
          description: "Total Stock Market ETF",
          shares: "20",
          market_value: "6000",
          cost_basis: "4000",
        },
        {
          symbol: "VMFXX",
          description: "Federal Money Market",
          shares: "4000",
          market_value: "4000",
        },
      ],
      transactions: [],
    }),
    acct({ id: "miles", name: "Miles", conn_id: "CON-CHASE", currency: "https://x.example/miles" }),
  ];
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/simplefin/claim/good" && init?.method === "POST") {
      if (claimed) return new Response("", { status: 403 });
      claimed = true;
      return new Response("https://user1:p%40ss@bridge.example/simplefin");
    }
    if (url.pathname !== "/simplefin/accounts") return json({}, 404);
    requests.push(url);
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    if (url.username || auth !== `Basic ${Buffer.from("user1:p@ss").toString("base64")}`) {
      return new Response("", { status: 403 });
    }
    const start = Number(url.searchParams.get("start-date") ?? 0);
    const end = Number(url.searchParams.get("end-date") ?? Number.MAX_SAFE_INTEGER);
    const only = url.searchParams.get("balances-only") === "1";
    return json({
      errlist,
      connections,
      accounts: accounts.map((a) => ({
        ...a,
        holdings: only ? [] : a.holdings,
        transactions: only
          ? []
          : (a.transactions ?? []).filter((t) => t.posted >= start && t.posted < end),
      })),
    });
  }) as typeof fetch;
  return {
    fetcher,
    requests,
    errlist,
    addBank: () => {
      connections.push({ conn_id: "CON-CITI", name: "Citi", org_id: "citi.com", org_name: "Citi" });
      accounts.push(
        acct({ id: "citi", name: "Double Cash Card", conn_id: "CON-CITI", balance: "-20" }),
      );
    },
  };
}

const setupToken = Buffer.from("https://bridge.example/simplefin/claim/good").toString("base64");

describe("SimpleFIN client", () => {
  it("only claims https tokens, and says a used token may be compromised", async () => {
    const bridge = fakeBridge();
    const client = new SimpleFinClient(bridge.fetcher, () => NOW);
    await expect(
      client.claim(Buffer.from("http://bridge.example/simplefin/claim/good").toString("base64")),
    ).rejects.toThrow(/https/);
    expect(await client.claim(setupToken)).toBe("https://user1:p%40ss@bridge.example/simplefin");
    await expect(client.claim(setupToken)).rejects.toThrow(/already used.*disable it/s);
  });

  it("shares answers between banks and stays under the Bridge's daily limit", async () => {
    const bridge = fakeBridge();
    let now = NOW;
    const client = new SimpleFinClient(bridge.fetcher, () => now);
    const url = "https://user1:p%40ss@bridge.example/simplefin";
    await Promise.all([client.accounts(url, { start: 1 }), client.accounts(url, { start: 1 })]);
    expect(bridge.requests).toHaveLength(1);
    // Credentials go in the header, never in the URL.
    expect(bridge.requests[0]?.username).toBe("");
    expect(bridge.requests[0]?.searchParams.get("version")).toBe("2");
    for (let i = 1; i < DAILY_REQUESTS; i++) await client.accounts(url, { start: 1 + i });
    expect(bridge.requests).toHaveLength(DAILY_REQUESTS);
    const over = await client.accounts(url, { start: 999 }).catch((e) => e);
    expect(over).toBeInstanceOf(SimpleFinError);
    expect((over as SimpleFinError).kind).toBe("daily_limit");
    now = new Date(NOW.getTime() + 86_400_001);
    await client.accounts(url, { start: 999 });
    expect(bridge.requests).toHaveLength(DAILY_REQUESTS + 1);
  });
});

describe("linking and syncing through SimpleFIN Bridge", () => {
  const url = inject("databaseUrl");
  const owner = connect(url);
  const cipher = new TokenCipher(randomBytes(32).toString("base64"));
  let userId = "";
  const agents: ReturnType<typeof connectAgent>[] = [];

  afterAll(async () => {
    await Promise.all(agents.map((a) => a.end()));
    if (userId) await owner.db.delete(appUser).where(eq(appUser.id, userId));
    await owner.close();
  });

  it("links every bank from one token, syncs them with shared requests, and asks to fix one", async () => {
    const { db } = owner;
    userId = await createUser(db, "SimpleFIN test", false, "US");
    const agentDb = connectAgent(url, userId);
    agents.push(agentDb);
    const bridge = fakeBridge();
    const client = new SimpleFinClient(bridge.fetcher, () => NOW);
    const plaid = withSimpleFin(new FakePlaid(), new SimpleFinGateway(client, () => NOW));
    const scheduler = new SyncScheduler(db, plaid, cipher);
    const app = createApp({
      db,
      plaid,
      cipher,
      scheduler,
      verifier: new PlaidWebhookVerifier(plaid),
      daysRequested: 730,
      userId,
      agentDb,
      simplefin: client,
      plaidConfigured: false,
    });
    const local = "http://127.0.0.1:8080";
    const post = (path: string, body: unknown) =>
      app.request(`${local}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: local },
        body: JSON.stringify(body),
      });

    const items = await (await app.request(`${local}/api/items`)).json();
    expect(items).toMatchObject({ plaid: false, simplefin: true });

    const linked = await post("/api/simplefin", { token: setupToken });
    expect(await linked.json()).toEqual({
      banks: [
        { name: "Chase", added: true },
        { name: "Vanguard", added: true },
      ],
    });
    await scheduler.idle();

    const rows = await db.select().from(item).where(eq(item.userId, userId));
    expect(
      rows.map((r) => [r.source, r.institutionName, r.institutionId, r.status]).sort(),
    ).toEqual([
      ["simplefin", "Chase", "sf:chase.com", "active"],
      ["simplefin", "Vanguard", "sf:vanguard.com", "active"],
    ]);
    // One balances-only request to link, then the first sync's windows, shared by both banks:
    // the newest, and older ones back to the first empty one.
    const windows = bridge.requests.filter((r) => r.searchParams.get("balances-only") !== "1");
    expect(new Set(windows.map((r) => r.search)).size).toBe(windows.length);
    expect(bridge.requests.length).toBeLessThanOrEqual(1 + 9);

    const accounts = await db.select().from(account).where(eq(account.userId, userId));
    // Points in a custom currency aren't money: no account for them.
    expect(accounts.map((a) => [a.name, a.type, a.subtype, a.mask]).sort()).toEqual([
      ["Brokerage Account", "investment", "brokerage", null],
      ["Sapphire Preferred (2222)", "credit", "credit card", "2222"],
      ["TOTAL CHECKING (1111)", "depository", "checking", "1111"],
    ]);
    const balances = await db
      .select()
      .from(balanceSnapshot)
      .where(eq(balanceSnapshot.userId, userId));
    expect(balances.map((b) => b.current).sort()).toEqual(["10000.0000", "5200.0000", "845.1000"]);
    const txns = await db.select().from(transaction).where(eq(transaction.userId, userId));
    expect(txns.map((t) => [t.date, t.amount, t.categoryDetailed]).sort()).toEqual([
      ["2026-11-10", "95.0000", "FOOD_AND_DRINK_GROCERIES"],
      ["2026-11-15", "1200.0000", null],
    ]);
    const held = await db
      .select({
        ticker: security.tickerSymbol,
        value: holding.institutionValue,
        type: security.type,
      })
      .from(holding)
      .innerJoin(security, eq(security.id, holding.securityId))
      .where(eq(holding.userId, userId));
    expect(held.sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)))).toEqual([
      { ticker: "VMFXX", value: "4000.0000", type: "cash" },
      { ticker: "VTI", value: "6000.0000", type: null },
    ]);

    // A later sync asks once, for the newest window only, and adds nothing twice.
    const chase = rows.find((r) => r.institutionName === "Chase");
    bridge.requests.length = 0;
    const later = new Date(NOW.getTime() + 6 * 3_600_000);
    const laterGateway = new SimpleFinGateway(
      new SimpleFinClient(bridge.fetcher, () => later),
      () => later,
    );
    const again = await syncItem(
      db,
      withSimpleFin(new FakePlaid(), laterGateway),
      cipher,
      chase?.id ?? "",
      () => later,
    );
    expect(again.status).toBe("succeeded");
    expect(bridge.requests).toHaveLength(1);
    expect(bridge.requests[0]?.searchParams.get("start-date")).toBe(
      String(unix("2026-11-21T00:00:00Z") - 44 * 86_400),
    );
    expect(await db.select().from(transaction).where(eq(transaction.userId, userId))).toHaveLength(
      2,
    );

    // The Bridge asks for a new sign-in at Chase: only Chase needs attention.
    bridge.errlist.push({
      code: "con.auth",
      msg: "Chase wants you to sign in",
      conn_id: "CON-CHASE",
    });
    const fresh = new SimpleFinGateway(new SimpleFinClient(bridge.fetcher, () => NOW), () => NOW);
    const plaid2 = withSimpleFin(new FakePlaid(), fresh);
    const failed = await syncItem(db, plaid2, cipher, chase?.id ?? "", () => NOW);
    expect(failed.status).toBe("failed");
    const vanguard = rows.find((r) => r.institutionName === "Vanguard");
    expect((await syncItem(db, plaid2, cipher, vanguard?.id ?? "", () => NOW)).status).toBe(
      "succeeded",
    );
    const after = await db.select().from(item).where(eq(item.userId, userId));
    expect(after.map((r) => [r.institutionName, r.status, r.statusDetail]).sort()).toEqual([
      ["Chase", "relink_required", "SIMPLEFIN_REAUTH"],
      ["Vanguard", "active", null],
    ]);

    // A bank added at the Bridge later comes in without a new token; the others stay as they are.
    bridge.addBank();
    const added = await post("/api/simplefin", {});
    expect(await added.json()).toEqual({ banks: [{ name: "Citi", added: true }] });
    await scheduler.idle();
    const citi = await db
      .select()
      .from(item)
      .where(and(eq(item.userId, userId), eq(item.institutionName, "Citi")));
    expect(citi).toHaveLength(1);
  });
});

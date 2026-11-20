import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { connect } from "../src/db/client.js";
import {
  account,
  appUser,
  cardTerms,
  factCheck,
  factImport,
  fundFee,
  holding,
  item,
  marketReading,
  security,
} from "../src/db/schema.js";
import { withPublicFacts } from "../src/facts/catalogs.js";
import { parseSurvey } from "../src/facts/cfpbCards.js";
import { factCheckProblem, staleFacts, surveyRowFor } from "../src/facts/checks.js";
import {
  readCardSurvey,
  readHoldingFees,
  readTreasuryBenchmark,
  searchCardTerms,
} from "../src/facts/read.js";
import { refreshFacts, TREASURY_SERIES } from "../src/facts/refresh.js";
import { filesToImport, parseDataSet, parseDataSetPage } from "../src/facts/secFunds.js";
import { readFirstSheet } from "../src/facts/xlsx.js";
import { unzipFile, zipNames } from "../src/facts/zip.js";
import { connectAgent, connectProposer } from "../src/mcp/agentDb.js";
import { getHoldings } from "../src/mcp/queries.js";
import { createTidysumMcpServer } from "../src/mcp/server.js";
import { parsePolicy } from "../src/policy/policy.js";
import { parseCardCatalog } from "../src/products/cardCatalog.js";
import { parseCatalog } from "../src/products/catalog.js";
import { makeZip } from "./zipWriter.js";

const TODAY = "2026-11-20";

// --- fixtures --------------------------------------------------------------------------------

const tsv = (rows: string[][]) => `${rows.map((r) => r.join("\t")).join("\n")}\n`;
const NUM_HEADER = [
  "adsh",
  "tag",
  "version",
  "ddate",
  "qtrs",
  "uom",
  "series",
  "class",
  "measure",
  "document",
  "otherdims",
  "iprx",
  "value",
];
const fee = (
  adsh: string,
  tag: string,
  cls: string,
  value: string,
  dims = "",
  ddate = "20260630",
) => [
  adsh,
  tag,
  "oef/2025",
  ddate,
  "0",
  "pure",
  "S1",
  cls,
  "",
  "doc",
  dims || `Class=${cls};LegalEntity=S1;`,
  "0",
  value,
];

/** One month's data set: an older and a newer filing for TEST1, a waiver for TEST2. */
function dataSet(newer = true): Buffer {
  const old = "0000000001-25-000001";
  const recent = "0000000001-26-000002";
  return makeZip({
    "sub.tsv": tsv([
      ["adsh", "cik", "name", "filed"],
      [old, "1", "Test Funds", "20250301"],
      ...(newer ? [[recent, "1", "Test Funds", "20260301"]] : []),
    ]),
    "scn.tsv": tsv([
      ["adsh", "seriesid", "seriesname", "classid", "classname", "ticker"],
      [old, "S1", "Test Index Fund", "C1", "ETF Shares", "test1"],
      [recent, "S1", "Test Index Fund", "C1", "ETF Shares", "TEST1"],
      [recent, "S1", "Test Index Fund", "C2", "Investor Shares", "TEST2"],
      [recent, "S1", "Test Index Fund", "C3", "Odd Shares", "TEST3"],
      [recent, "S1", "Test Index Fund", "C4", "No Ticker", ""],
    ]),
    "num.tsv": tsv([
      NUM_HEADER,
      fee(old, "ExpensesOverAssets", "C1", "0.0009"),
      fee(recent, "ExpensesOverAssets", "C1", "0.0005"),
      fee(recent, "ExpensesOverAssets", "C2", "0.0040"),
      fee(recent, "NetExpensesOverAssets", "C2", "0.0036"),
      fee(recent, "ExpensesOverAssets", "C3", "0.0100", "Class=C3;Scenario=Max;"),
      fee(recent, "ExpensesOverAssets", "C4", "0.0020"),
      fee(recent, "ExpenseExampleYear01", "C1", "5"),
    ]),
  });
}

const SEC_PAGE = `<a href="/files/dera/data/rr/2026-10_rr1.zip">Oct</a>
  <a href="/files/dera/data/rr/2026q3_rr1.zip">Q3</a>
  <a href="/files/dera/data/rr/2024_rr1.zip">2024</a>`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
/** An .xlsx whose first sheet holds these rows, strings shared, like Excel writes them. */
function workbook(rows: string[][]): Buffer {
  const strings: string[] = [];
  const cell = (v: string, c: number, r: number) => {
    const ref = `${String.fromCharCode(65 + (c % 26)).padStart(c >= 26 ? 2 : 1, "A")}${r}`;
    if (v === "") return "";
    if (/^\d+(\.\d+)?$/.test(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    strings.push(v);
    return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`;
  };
  const body = rows
    .map((r, i) => `<row r="${i + 1}">${r.map((v, c) => cell(v, c, i + 1)).join("")}</row>`)
    .join("");
  return makeZip({
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet><sheetData>${body}</sheetData></worksheet>`,
    "xl/sharedStrings.xml": `<sst>${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`,
  });
}

const SURVEY_HEADER = [
  "Institution Name",
  "Product Name",
  "Report Date",
  "Availability of Credit Card Plan",
  "Secured Card",
  "Annual Fee",
  "Purchase APR min",
  "Purchase APR median",
  "Purchase APR max",
  "Introductory APR Offered?",
  "Foreign Transaction Fees?",
  "Foreign Transaction Fee (%)",
  "Rewards",
  "Targeted Credit Tiers",
  "Website for Consumer",
];
const survey = workbook([
  ["Terms of Credit Card Plans survey results"],
  [],
  SURVEY_HEADER,
  [
    "Jpmorgan Chase Bank, National Association",
    "Sapphire Preferred®",
    '="2025-12-31"',
    "National",
    "No",
    "95",
    "0.1924",
    "0.2749",
    "0.2749",
    "No",
    "No",
    "",
    "Cashback rewards; Travel-related rewards",
    "Credit score of 720 or greater",
    "https://www.chase.com",
  ],
  [
    "Jpmorgan Chase Bank, National Association",
    "Freedom Flex",
    '="2025-12-31"',
    "National",
    "No",
    "",
    "0.1974",
    "0.2549",
    "0.2849",
    "Yes",
    "Yes",
    "0.03",
    "Cashback rewards",
    "",
    "https://www.chase.com",
  ],
]);
const CFPB_PAGE = `<a href="https://files.consumerfinance.gov/f/documents/cfpb_tccp-data_2025-12-31.xlsx">Download</a>`;

function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const hit = Object.keys(routes).find((k) => url.includes(k));
    if (!hit) return new Response("not found", { status: 404 });
    return routes[hit]?.() ?? new Response("", { status: 500 });
  }) as typeof fetch;
}
const bytes = (b: Buffer) => () => new Response(new Uint8Array(b));
const text = (s: string) => () => new Response(s);

const fetchers = {
  sec: fakeFetch({
    "riskreturn-summary-data-sets": text(SEC_PAGE),
    "2026-10_rr1.zip": bytes(dataSet()),
    "2026q3_rr1.zip": bytes(dataSet(false)),
  }),
  cfpb: fakeFetch({
    "terms-credit-card-plans-survey": text(CFPB_PAGE),
    "cfpb_tccp-data_2025-12-31.xlsx": bytes(survey),
  }),
  treasury: fakeFetch({
    "daily-treasury-rates.csv/2026": text(
      'Date,"4 WEEKS COUPON EQUIVALENT","13 WEEKS BANK DISCOUNT","13 WEEKS COUPON EQUIVALENT"\n' +
        "11/19/2026,4.12,4.16,4.34\n11/18/2026,3.98,4.16,\n11/17/2026,4.10,4.15,4.33\n",
    ),
  }),
};

const deposits = parseCatalog({
  version: 1,
  products: [
    {
      id: "bank-savings",
      provider: "Example Bank",
      institutions: ["example bank"],
      name: "Example Savings",
      kind: "savings",
      insurance: "FDIC",
      apy: [{ from: "0", apy: "3.30" }],
      monthly_fee: "0.00",
      overdraft_fees: false,
      source_url: "https://www.examplebank.com/rates",
      rates_as_of: "2026-09-01",
      verified_on: "2026-09-01",
    },
  ],
});
const cards = parseCardCatalog({
  version: 1,
  categories: { dining: { label: "Dining", codes: { plaid: ["FOOD_AND_DRINK_RESTAURANT"] } } },
  cards: [
    {
      id: "chase-sapphire-preferred",
      issuer: "Chase",
      name: "Chase Sapphire Preferred",
      annual_fee: "95",
      foreign_transaction_fee: "0",
      reward: { currency: "cash" },
      base_rate: "1",
      source_url: "https://creditcards.chase.com/sapphire/preferred",
      verified_on: "2026-11-15",
    },
    {
      id: "chase-freedom-flex",
      issuer: "Chase",
      name: "Chase Freedom Flex",
      annual_fee: "0",
      foreign_transaction_fee: "0",
      reward: { currency: "cash" },
      base_rate: "1",
      source_url: "https://creditcards.chase.com/freedom/flex",
      verified_on: "2026-11-15",
    },
  ],
});

// --- database --------------------------------------------------------------------------------

const url = inject("databaseUrl");
const owner = connect(url);
const [user] = await owner.db
  .insert(appUser)
  .values({ displayName: "Facts test" })
  .returning({ id: appUser.id });
const [other] = await owner.db
  .insert(appUser)
  .values({ displayName: "Facts test, other" })
  .returning({ id: appUser.id });
if (!user || !other) throw new Error("no user");
const agentDb = connectAgent(url, user.id);
const proposer = connectProposer(url, user.id);

async function clean() {
  await owner.db.delete(fundFee);
  await owner.db.delete(cardTerms);
  await owner.db.delete(factImport);
  await owner.db.delete(factCheck);
  await owner.db.delete(marketReading).where(eq(marketReading.series, TREASURY_SERIES));
}

afterAll(async () => {
  await clean();
  await owner.db.delete(appUser).where(sql`${appUser.id} in (${user.id}, ${other.id})`);
  await owner.db.delete(security).where(sql`${security.id} like 'facts-%'`);
  await agentDb.end();
  await proposer.end();
  await owner.close();
});

describe("reading downloaded files", () => {
  it("reads a zip archive's entries", () => {
    const zip = makeZip({ "a.txt": "hello", "b/c.txt": "x".repeat(10_000) });
    expect(zipNames(zip)).toEqual(["a.txt", "b/c.txt"]);
    expect(unzipFile(zip, "a.txt")?.toString()).toBe("hello");
    expect(unzipFile(zip, "b/c.txt")?.length).toBe(10_000);
    expect(unzipFile(zip, "missing")).toBeUndefined();
    expect(() => zipNames(Buffer.from("not a zip at all, just text"))).toThrow("not a zip");
  });

  it("reads an xlsx sheet as text, keeping numbers as written", () => {
    const rows = readFirstSheet(
      workbook([
        ["Name", "Fee"],
        ["A & B", "0.26489999999999997"],
      ]),
    );
    expect(rows).toEqual([
      ["Name", "Fee"],
      ["A & B", "0.26489999999999997"],
    ]);
  });
});

describe("SEC fund fees", () => {
  it("lists the data set files and picks the last year's", () => {
    const files = parseDataSetPage(SEC_PAGE);
    expect(files.map((f) => [f.name, f.months.length])).toEqual([
      ["2026-10_rr1.zip", 1],
      ["2026q3_rr1.zip", 3],
      ["2024_rr1.zip", 12],
    ]);
    expect(files[0]?.url).toBe("https://www.sec.gov/files/dera/data/rr/2026-10_rr1.zip");
    expect(filesToImport(files, [], TODAY).map((f) => f.name)).toEqual([
      "2026-10_rr1.zip",
      "2026q3_rr1.zip",
    ]);
    expect(filesToImport(files, ["2026-10_rr1.zip"], TODAY).map((f) => f.name)).toEqual([
      "2026q3_rr1.zip",
    ]);
  });

  it("takes each class's fee after waivers from its newest filing, and skips the rest", () => {
    const fees = parseDataSet(dataSet());
    expect(fees.map((f) => [f.ticker, f.expense_ratio, f.gross_expense_ratio, f.filed])).toEqual([
      ["TEST1", "0.05", null, "2026-03-01"],
      ["TEST2", "0.36", "0.4", "2026-03-01"],
    ]);
    expect(fees[0]?.source_url).toBe(
      "https://www.sec.gov/Archives/edgar/data/1/000000000126000002/0000000001-26-000002-index.htm",
    );
  });
});

describe("CFPB card terms", () => {
  it("reads fees and APRs as percents and dollars", () => {
    const [sapphire, flex] = parseSurvey(survey);
    expect(sapphire).toMatchObject({
      product: "Sapphire Preferred®",
      report_date: "2025-12-31",
      annual_fee: "95.00",
      purchase_apr_min: "19.24",
      purchase_apr_max: "27.49",
      foreign_transaction_fee: "0",
      national: true,
    });
    expect(flex).toMatchObject({
      annual_fee: null,
      foreign_transaction_fee: "3.00",
      intro_apr: true,
    });
  });

  it("matches a catalog card to its survey row by issuer and name only", () => {
    const rows = parseSurvey(survey).map((r) => ({ ...r, source_url: "x" }));
    expect(surveyRowFor(cards.cards[0] as never, rows)?.product).toBe("Sapphire Preferred®");
    expect(surveyRowFor({ ...cards.cards[0], issuer: "Citi" } as never, rows)).toBeNull();
  });
});

describe("refreshing public facts", () => {
  beforeAll(clean);

  it("imports every source, then skips them until they're due", async () => {
    const now = new Date(`${TODAY}T12:00:00Z`);
    const first = await refreshFacts(owner.db, TODAY, { fetchers, now });
    expect(first.map((r) => [r.source, r.status, r.rows])).toEqual([
      ["sec_funds", "imported", 3],
      ["cfpb_cards", "imported", 2],
      ["treasury", "imported", 2],
    ]);
    const fees = await owner.db.select().from(fundFee).orderBy(fundFee.ticker);
    // The quarter's file has only the older filing; it never overwrites the newer fee.
    expect(fees.map((f) => [f.ticker, f.expenseRatio])).toEqual([
      ["TEST1", "0.0500"],
      ["TEST2", "0.3600"],
    ]);

    const again = await refreshFacts(owner.db, TODAY, { fetchers, now });
    expect(again.map((r) => r.status)).toEqual(["skipped", "skipped", "skipped"]);
    const forced = await refreshFacts(owner.db, TODAY, { fetchers, now, force: true });
    // Files already imported aren't fetched again; the Treasury's month of readings is re-recorded.
    expect(forced.map((r) => r.status)).toEqual(["nothing_new", "nothing_new", "imported"]);
  });

  it("logs a failing source and retries it hours later, not a week", async () => {
    const down = { ...fetchers, treasury: fakeFetch({}) };
    const now = new Date("2026-11-21T01:00:00Z");
    const r = await refreshFacts(owner.db, TODAY, { fetchers: down, now, only: ["treasury"] });
    expect(r[0]).toMatchObject({ status: "failed", error: "Treasury bill rates 2026: HTTP 404" });
    const soon = new Date("2026-11-21T01:30:00Z");
    expect(
      (await refreshFacts(owner.db, TODAY, { fetchers, now: soon, only: ["treasury"] }))[0]?.status,
    ).toBe("skipped");
    const later = new Date("2026-11-21T08:00:00Z");
    expect(
      (await refreshFacts(owner.db, TODAY, { fetchers, now: later, only: ["treasury"] }))[0]
        ?.status,
    ).toBe("imported");
  });

  it("gives agents fund fees, card terms and the Treasury yield", async () => {
    const [it] = await owner.db
      .insert(item)
      .values({ userId: user.id, source: "csv", institutionName: "Facts Brokerage" })
      .returning();
    const [acct] = await owner.db
      .insert(account)
      .values({ userId: user.id, itemId: it?.id ?? "", name: "Brokerage", type: "investment" })
      .returning();
    await owner.db.insert(security).values([
      { id: "facts-test1", name: "Test Index ETF", tickerSymbol: "TEST1", type: "etf" },
      { id: "facts-stock", name: "Some Stock", tickerSymbol: "SOME", type: "equity" },
    ]);
    const base = { userId: user.id, accountId: acct?.id ?? "", currency: "USD", asOf: new Date() };
    await owner.db.insert(holding).values([
      {
        ...base,
        securityId: "facts-test1",
        quantity: "100",
        institutionPrice: "100",
        institutionValue: "10000.00",
      },
      {
        ...base,
        securityId: "facts-stock",
        quantity: "10",
        institutionPrice: "200",
        institutionValue: "2000.00",
      },
    ]);

    const r = await readHoldingFees(agentDb);
    expect(r.annual_cost).toBe("5.00");
    expect(r.weighted_expense_ratio).toBe("0.050");
    expect(r.priced_share).toBe("83.3");
    expect(r.funds.map((f) => [f.ticker, f.expense_ratio, f.annual_cost])).toEqual([
      ["TEST1", "0.05", "5.00"],
      ["SOME", null, null],
    ]);
    expect(r.funds[1]?.why_unknown).toBe("a stock: it has no expense ratio");
    const held = await getHoldings(agentDb);
    expect(held.holdings.find((h) => h.ticker_symbol === "TEST1")?.expense_ratio).toBe("0.05");

    expect((await searchCardTerms(agentDb, "chase sapphire")).map((c) => c.product)).toEqual([
      "Sapphire Preferred®",
    ]);
    expect(await searchCardTerms(agentDb, "nothing like this")).toEqual([]);
    expect(await readTreasuryBenchmark(agentDb)).toMatchObject({
      yield: "4.34",
      as_of: "2026-11-19",
    });
  });
});

describe("fact checks", () => {
  const check = (over: Record<string, unknown>) =>
    factCheckProblem(
      {
        kind: "deposit",
        product_id: "bank-savings",
        outcome: "confirmed",
        source_url: "https://www.examplebank.com/rates",
        quote: "Earn 3.30% APY on every balance.",
        ...over,
      } as never,
      deposits,
      cards,
      TODAY,
    );

  it("accepts only the provider's own page, with the numbers in the quote", () => {
    expect(check({})).toBeNull();
    expect(check({ source_url: "https://www.bankrate.com/banking/savings/" })).toContain(
      "provider's own site",
    );
    expect(check({ quote: "Our savings account is great for everyone." })).toContain(
      "current numbers",
    );
    expect(
      check({
        outcome: "changed",
        changes: { apy: "3.10" },
        quote: "Now 3.10% APY on all balances",
      }),
    ).toBeNull();
    expect(
      check({
        outcome: "changed",
        changes: { apy: "3.15" },
        quote: "Now 3.10% APY on all balances",
      }),
    ).toContain("must state the new apy");
    expect(check({ outcome: "changed", changes: {} })).toContain("at least one field");
    expect(
      check({ outcome: "changed", changes: { annual_fee: "0" }, quote: "No annual fee, 3.30%" }),
    ).toContain("isn't a deposit field");
    expect(check({ product_id: "nope" })).toContain("no deposit product nope");
    expect(
      check({
        kind: "card",
        product_id: "chase-freedom-flex",
        outcome: "changed",
        changes: { foreign_transaction_fee: "3" },
        source_url: "https://www.chase.com/pricing",
        quote: "Foreign Transaction: 3% of each transaction in U.S. dollars.",
      }),
    ).toBeNull();
    expect(
      check({
        kind: "card",
        product_id: "chase-freedom-flex",
        outcome: "changed",
        changes: { annual_fee: "0" },
        source_url: "https://creditcards.chase.com/freedom/flex",
        quote: "No annual fee and cash back on everything.",
      }),
    ).toBeNull();
  });

  it("records checks as the agent's own user and lays them over the catalogs", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const products = withPublicFacts(
      { loadCatalog: async () => deposits, loadCardCatalog: async () => cards, today: () => TODAY },
      agentDb,
    );
    await createTidysumMcpServer(
      agentDb,
      {
        proposer,
        loadPolicy: async () =>
          ({
            policy: parsePolicy({
              version: 1,
              cash: { buffer: { amount: "500" }, tolerance: "100" },
            }),
            version: 1,
            contentSha256: "x",
          }) as never,
        today: () => TODAY,
      },
      products,
    ).connect(serverTransport);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await client.callTool({ name, arguments: args });
      const [first] = res.content as { text: string }[];
      if (res.isError) throw new Error(first?.text);
      return JSON.parse(first?.text ?? "null");
    };

    const before = await call("list_stale_facts");
    expect(
      before.stale.map((f: { product_id: string; reasons: string[] }) => [f.product_id, f.reasons]),
    ).toEqual([
      ["bank-savings", ["verified 80 days ago"]],
      [
        "chase-freedom-flex",
        ["the CFPB's survey (as of 2025-12-31) lists a 3.00% foreign transaction fee"],
      ],
    ]);

    await expect(
      call("submit_fact_check", {
        kind: "deposit",
        product_id: "bank-savings",
        outcome: "changed",
        changes: { apy: "3.75" },
        source_url: "https://www.examplebank.com/rates",
        quote: "Earn 3.10% APY",
      }),
    ).rejects.toThrow("must state the new apy");

    expect(
      await call("submit_fact_check", {
        kind: "deposit",
        product_id: "bank-savings",
        outcome: "changed",
        changes: { apy: "3.10" },
        source_url: "https://www.examplebank.com/rates",
        quote: "Example Savings earns 3.10% APY, as of November 18, 2026.",
        rates_as_of: "2026-11-18",
      }),
    ).toEqual({ recorded: true, checked_on: TODAY });
    await call("submit_fact_check", {
      kind: "card",
      product_id: "chase-freedom-flex",
      outcome: "changed",
      changes: { foreign_transaction_fee: "3" },
      source_url: "https://creditcards.chase.com/freedom/flex/pricing",
      quote: "Foreign Transaction: 3% of each transaction in U.S. dollars.",
    });

    expect((await call("list_stale_facts")).stale).toEqual([]);
    const checked = await products.loadCatalog();
    expect(checked.products[0]).toMatchObject({
      apy: [{ from: "0", apy: "3.10" }],
      rates_as_of: "2026-11-18",
      verified_on: TODAY,
    });
    expect((await products.loadCardCatalog?.())?.cards[1]?.foreign_transaction_fee).toBe("3");
    // A later edit of the catalog file wins over older checks.
    const edited = withPublicFacts(
      {
        loadCatalog: async () => ({
          ...deposits,
          products: deposits.products.map((p) => ({ ...p, verified_on: "2026-11-25" })),
        }),
      },
      agentDb,
    );
    expect((await edited.loadCatalog()).products[0]?.apy).toEqual([{ from: "0", apy: "3.30" }]);

    const fees = await call("fund_fees");
    expect(fees.annual_cost).toBe("5.00");
    expect(
      (await call("card_terms", { query: "freedom flex" })).cards[0].foreign_transaction_fee,
    ).toBe("3.00");
    expect((await call("benchmark_rates")).treasury.yield).toBe("4.34");
    await client.close();
  });

  it("won't let an agent record a check as another user", async () => {
    await expect(
      proposer.query(
        `insert into fact_check (kind, product_id, outcome, source_url, quote, checked_on, user_id)
         values ('card', 'x', 'confirmed', 'https://a.com', 'quote here', $1, $2)`,
        [TODAY, other.id],
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(agentDb.query("delete from fact_check")).rejects.toThrow();
    expect((await readCardSurvey(agentDb)).length).toBe(2);
  });

  it("lists stale products oldest first", () => {
    const facts = staleFacts(deposits, cards, [], [], "2026-12-30");
    expect(facts.map((f) => [f.product_id, f.age_days])).toEqual([
      ["bank-savings", 120],
      ["chase-freedom-flex", 45],
      ["chase-sapphire-preferred", 45],
    ]);
  });
});

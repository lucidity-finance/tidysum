import Big from "big.js";
import { beforeAll, describe, expect, it } from "vitest";
import { parsePolicy } from "../src/policy/policy.js";
import type { Snapshot, SnapshotAccount, SnapshotHolding } from "../src/policy/snapshot.js";
import {
  type BrokerageInput,
  brokerageFindings,
  driftCost,
  type Fee,
  isIdleCash,
} from "../src/portfolio/brokerage.js";
import { loadSecurityCatalogFile, type SecurityCatalog } from "../src/portfolio/securityCatalog.js";
import { regionOf } from "../src/region.js";

const TODAY = "2026-11-20";
const TAXABLE = "00000000-0000-4000-8000-000000000101";
const ROTH = "00000000-0000-4000-8000-000000000102";
const ROBINHOOD = "00000000-0000-4000-8000-000000000103";
const VANGUARD = "00000000-0000-4000-8000-000000000104";
const ETRADE = "00000000-0000-4000-8000-000000000105";
const PLAN = "00000000-0000-4000-8000-000000000106";

let catalog: SecurityCatalog;
beforeAll(async () => {
  catalog = await loadSecurityCatalogFile("catalog/securities.json");
});

const sec = (fees: Record<string, string>) =>
  new Map<string, Fee>(
    Object.entries(fees).map(([t, er]) => [
      t,
      { expense_ratio: er, as_of: "2026-06-30", source_url: "https://www.sec.gov/" },
    ]),
  );

function account(
  id: string,
  name: string,
  subtype: string,
  institution: string,
  current = "0",
): SnapshotAccount {
  return {
    id,
    name,
    institution_name: institution,
    type: "investment",
    subtype,
    currency: "USD",
    current,
    available: null,
    balance_as_of: TODAY,
  };
}

function holding(
  account_id: string,
  ticker: string | null,
  type: string,
  value: string,
  cost_basis: string | null = null,
  name: string | null = ticker,
): SnapshotHolding {
  return {
    account_id,
    security_id: `sec-${account_id}-${ticker}`,
    ticker_symbol: ticker,
    security_name: name,
    is_cash_equivalent: type === "cash",
    security_type: type,
    institution_value: value,
    cost_basis,
  };
}

const ACCOUNTS = [
  account(TAXABLE, "Self-Directed", "brokerage", "Chase"),
  account(ROTH, "Roth IRA", "roth", "Fidelity"),
  account(ROBINHOOD, "Robinhood individual", "brokerage", "Robinhood"),
  account(VANGUARD, "Brokerage Account", "brokerage", "Vanguard"),
  account(ETRADE, "Brokerage", "brokerage", "E*TRADE"),
];

function snapshot(holdings: SnapshotHolding[], accounts = ACCOUNTS, country = "US"): Snapshot {
  const { currency } = regionOf(country);
  return {
    today: TODAY,
    currency,
    country,
    investing_enabled: true,
    accounts,
    liabilities: [],
    holdings,
    spending: [],
  };
}

function run(over: Partial<BrokerageInput> & { snapshot: Snapshot }) {
  return brokerageFindings({
    today: TODAY,
    region: regionOf(over.snapshot.country),
    policy: null,
    catalog,
    secFees: sec({ QQQM: "0.15", VOO: "0.03", IVV: "0.03", VFIAX: "0.04", SGOV: "0.09" }),
    benchmark: {
      name: "13-week (3-month) US Treasury bill yield",
      yield: "4.26",
      as_of: "2026-11-19",
      source_url: "https://home.treasury.gov/",
    },
    memberships: [],
    planAccountIds: [],
    ...over,
  });
}

describe("holding_fee", () => {
  it("swaps a fund for the cheaper one holding the same index, tax-free in an IRA", () => {
    const r = run({ snapshot: snapshot([holding(ROTH, "QQQ", "etf", "20000.00", "9000.00")]) });
    const f = r.items.find((m) => m.detector === "holding_fee");
    expect(f).toMatchObject({
      key: `holding_fee:${ROTH}:QQQ`,
      annual_cost: "6.00",
      account_ids: [ROTH],
      action: "Swap QQQ for QQQM in Roth IRA",
      inputs: {
        expense_ratio: "0.18",
        alternative: { ticker: "QQQM", expense_ratio: "0.15" },
        tax: { kind: "sheltered" },
      },
    });
    expect(f?.summary).toContain("Nasdaq-100");
    expect(r.ran).toContain("holding_fee");
    expect(r.tickers[ROTH]).toEqual(["QQQ"]);
  });

  it("keeps a taxable fund whose gain the saving takes years to pay back", () => {
    const r = run({ snapshot: snapshot([holding(TAXABLE, "QQQ", "etf", "24000.00", "12000.00")]) });
    expect(r.items.filter((m) => m.detector === "holding_fee")).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/QQQ → QQQM.*buy the cheaper fund with new money/);
  });

  it("swaps at a small gain when the fee pays the tax back within two years", () => {
    const r = run({ snapshot: snapshot([holding(TAXABLE, "GLD", "etf", "10000.00", "9900.00")]) });
    const f = r.items.find((m) => m.detector === "holding_fee");
    // 0.40% against GLDM's 0.10% on $10,000 is $30 a year; 15% of a $100 gain is $15: 6 months.
    expect(f).toMatchObject({
      annual_cost: "30.00",
      inputs: {
        alternative: { ticker: "GLDM" },
        tax: { kind: "gain", tax: "15.00", payback_months: 6 },
      },
    });
    expect(f?.summary).toContain("about 6 months");
  });

  it("owes nothing to sell below cost, and says so", () => {
    const r = run({ snapshot: snapshot([holding(TAXABLE, "GLD", "etf", "10000.00", "12000.00")]) });
    expect(r.items[0]?.inputs).toMatchObject({ tax: { kind: "no_gain" } });
    expect(r.items[0]?.summary).toMatch(/owes no tax/);
  });

  it("leaves the swap undecided when the brokerage doesn't report cost basis", () => {
    const r = run({ snapshot: snapshot([holding(TAXABLE, "GLD", "etf", "10000.00", null)]) });
    expect(r.items).toEqual([]);
    expect(r.undecided).toEqual([`holding_fee:${TAXABLE}:GLD`]);
  });

  it("never swaps a fund nothing else copies, or a fund already the cheapest", () => {
    const r = run({
      snapshot: snapshot([
        holding(ROTH, "GRID", "etf", "50000.00"),
        holding(ROTH, "SMH", "etf", "50000.00"),
        holding(ROTH, "VOO", "etf", "50000.00"),
      ]),
      secFees: sec({ GRID: "0.56", SMH: "0.35", VOO: "0.03", IVV: "0.03" }),
    });
    expect(r.items).toEqual([]);
  });

  it("prices a mutual fund swap and waits for calm markets, since the money sits out a day", () => {
    const r = run({ snapshot: snapshot([holding(ROTH, "VFIAX", "mutual fund", "100000.00")]) });
    expect(r.items[0]).toMatchObject({
      annual_cost: "10.00",
      inputs: { alternative: { ticker: "IVV" }, mutual_fund: true, wait_for: "calm_markets" },
    });
  });

  it("prefers a copy the owner already holds when it costs the same", () => {
    const r = run({
      snapshot: snapshot([
        holding(ROTH, "VFIAX", "mutual fund", "100000.00"),
        holding(TAXABLE, "VOO", "etf", "1000.00", "900.00"),
      ]),
    });
    expect(r.items[0]?.inputs).toMatchObject({ alternative: { ticker: "VOO", held: true } });
  });

  it("leaves workplace plans and their brokerage windows to fund_fee and brokerage_window", () => {
    const plan = account(PLAN, "401(k)", "401k", "Principal", "100000.00");
    const window = account(ROTH, "PCRA Trust", "ira", "Charles Schwab", "50000.00");
    const r = run({
      snapshot: snapshot(
        [
          holding(PLAN, null, "other", "50000.00", null, "Self-Directed Brokerage Account"),
          holding(PLAN, null, "mutual fund", "50000.00", null, "Index Fund"),
          holding(ROTH, "VFIAX", "mutual fund", "50000.00"),
        ],
        [plan, window],
      ),
      planAccountIds: [PLAN],
    });
    expect(r.items).toEqual([]);
    expect(Object.keys(r.tickers)).toEqual([]);
  });

  it("swaps within the owner's own market: a UK ISA gets a UK-listed fund", () => {
    const isa = account(TAXABLE, "Stocks and Shares ISA", "brokerage", "Vanguard UK");
    const r = run({
      snapshot: snapshot([holding(TAXABLE, "VUKE", "etf", "50000.00", "60000.00")], [isa], "GB"),
      secFees: new Map(),
      benchmark: null,
    });
    expect(r.items[0]).toMatchObject({
      currency: "GBP",
      annual_cost: "10.00",
      inputs: { alternative: { ticker: "ISF" }, tax: { kind: "sheltered" } },
    });
  });

  it("outside the US, doesn't sell at a gain in a taxable account", () => {
    const gia = account(TAXABLE, "General Account", "brokerage", "Hargreaves Lansdown");
    const r = run({
      snapshot: snapshot([holding(TAXABLE, "VUKE", "etf", "50000.00", "40000.00")], [gia], "GB"),
      secFees: new Map(),
      benchmark: null,
    });
    expect(r.items).toEqual([]);
    expect(r.warnings.join(" ")).toContain("VUKE → ISF");
  });
});

describe("brokerage_cash", () => {
  it("knows cash that sits as cash from a money market fund", () => {
    expect(isIdleCash(holding(ROBINHOOD, "CUR:USD", "cash", "1.00"))).toBe(true);
    expect(isIdleCash(holding(ROBINHOOD, null, "cash", "1.00"))).toBe(true);
    expect(isIdleCash(holding(VANGUARD, "VMFXX", "cash", "1.00"))).toBe(false);
    expect(isIdleCash(holding(VANGUARD, "VOO", "etf", "1.00"))).toBe(false);
  });

  it("prices Robinhood cash at the Gold rate for a Gold member, against a T-bill fund", () => {
    const r = run({
      snapshot: snapshot([
        holding(ROBINHOOD, "CUR:USD", "cash", "5000.00", null, "U S Dollar"),
        holding(VANGUARD, "VMFXX", "cash", "5000.00"),
      ]),
      memberships: ["Robinhood Gold"],
    });
    const f = r.items.filter((m) => m.detector === "brokerage_cash");
    // SGOV: 4.26% less its 0.09% fee is 4.17%; Gold pays 3.60%: 0.57% of $5,000.
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      key: `brokerage_cash:${ROBINHOOD}`,
      annual_cost: "28.50",
      inputs: { apy: "3.6", membership: "Robinhood Gold", alternative: { ticker: "SGOV" } },
    });
    expect(f[0]?.summary).toMatch(/earns 3.6% with Robinhood Gold.*about 4.17%/);
    expect(f[0]?.summary).not.toContain("5,000");
    expect(r.cash[VANGUARD]).toBe("0.00");
  });

  it("without Gold, Robinhood cash earns nothing", () => {
    const r = run({
      snapshot: snapshot([holding(ROBINHOOD, "CUR:USD", "cash", "5000.00")]),
    });
    expect(r.items[0]).toMatchObject({
      annual_cost: "208.50",
      inputs: { apy: "0", membership_available: { name: "Robinhood Gold", apy: "3.60" } },
    });
  });

  it("leaves cash at a brokerage whose rate it doesn't know undecided", () => {
    const r = run({ snapshot: snapshot([holding(ETRADE, "CUR:USD", "cash", "5000.00")]) });
    expect(r.items).toEqual([]);
    expect(r.undecided).toEqual([`brokerage_cash:${ETRADE}`]);
  });

  it("doesn't run without a cash yardstick", () => {
    const r = run({
      snapshot: snapshot([holding(ROBINHOOD, "CUR:USD", "cash", "5000.00")]),
      benchmark: null,
    });
    expect(r.ran).not.toContain("brokerage_cash");
    expect(r.warnings.join(" ")).toMatch(/yardstick/);
  });
});

describe("allocation_drift", () => {
  it("prices drift as ½·γ·dᵀΣd with γ from the target's own risk and return", () => {
    const risk = catalog.risk;
    if (!risk) throw new Error("catalog has no risk figures");
    const priced = driftCost(risk, [
      { classes: ["us_stocks"], current: new Big("0.7"), target: new Big("0.6") },
      { classes: ["bonds"], current: new Big("0.3"), target: new Big("0.4") },
    ]);
    // Target variance 0.011257, excess return over cash 3.628%: γ ≈ 3.223. dᵀΣd = 0.000246879.
    expect(Number(priced?.gamma)).toBeCloseTo(3.2229, 3);
    expect(Number(priced?.rate)).toBeCloseTo(0.000397836, 8);
    // On target it costs nothing, and the cost doesn't depend on which way the mix drifted.
    const none = driftCost(risk, [
      { classes: ["us_stocks"], current: new Big("0.6"), target: new Big("0.6") },
      { classes: ["bonds"], current: new Big("0.4"), target: new Big("0.4") },
    ]);
    expect(Number(none?.rate)).toBe(0);
    const other = driftCost(risk, [
      { classes: ["us_stocks"], current: new Big("0.5"), target: new Big("0.6") },
      { classes: ["bonds"], current: new Big("0.5"), target: new Big("0.4") },
    ]);
    expect(Number(other?.rate)).toBeCloseTo(Number(priced?.rate), 10);
  });

  const policy = parsePolicy({
    version: 1,
    cash: { buffer: { amount: "5000.00" } },
    allocation: {
      drift_band: "0.05",
      buckets: {
        us_stocks: { target: "0.60", tickers: [] },
        intl_stocks: { target: "0.30", tickers: [] },
        bonds_and_cash: { target: "0.10", tickers: [], cash_equivalents: true },
      },
    },
  }).policy;

  it("prices a mix outside its band and points at new money, never selling", () => {
    const r = run({
      snapshot: snapshot([
        holding(TAXABLE, "VTI", "etf", "80000.00", "50000.00"),
        holding(TAXABLE, "VXUS", "etf", "10000.00", "9000.00"),
        holding(TAXABLE, "BND", "etf", "10000.00", "10000.00"),
      ]),
      secFees: sec({ VTI: "0.03", VXUS: "0.05", BND: "0.03" }),
      policy,
    });
    const f = r.items.find((m) => m.detector === "allocation_drift");
    expect(f).toMatchObject({
      key: "allocation_drift",
      category: "securities",
      action: "Invest new money toward your target mix",
    });
    expect(new Big(f?.annual_cost ?? 0).gt(0)).toBe(true);
    // 20 points between US and international stocks: well under 0.1% of $100,000 a year.
    expect(new Big(f?.annual_cost ?? 0).lt(100)).toBe(true);
    expect(f?.summary).toMatch(/US stocks 80% \(target 60%\)/);
    expect(f?.summary).toMatch(/no selling/);
    expect(f?.summary).not.toMatch(/\$/);
  });

  it("stays quiet inside the drift band", () => {
    const r = run({
      snapshot: snapshot([
        holding(TAXABLE, "VTI", "etf", "62000.00", "50000.00"),
        holding(TAXABLE, "VXUS", "etf", "28000.00", "27000.00"),
        holding(TAXABLE, "BND", "etf", "10000.00", "10000.00"),
      ]),
      policy,
    });
    expect(r.ran).toContain("allocation_drift");
    expect(r.items.filter((m) => m.detector === "allocation_drift")).toEqual([]);
  });
});

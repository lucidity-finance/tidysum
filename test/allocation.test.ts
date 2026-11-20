import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../src/policy/engine.js";
import { parsePolicy } from "../src/policy/policy.js";
import type { Snapshot, SnapshotHolding } from "../src/policy/snapshot.js";
import {
  allocationForPage,
  buildAllocationReport,
  classifyHoldings,
} from "../src/portfolio/allocation.js";
import {
  loadSecurityCatalogFile,
  parseSecurityCatalog,
  type SecurityCatalog,
} from "../src/portfolio/securityCatalog.js";

const TAXABLE = "00000000-0000-4000-8000-000000000011";
const IRA = "00000000-0000-4000-8000-000000000012";

const policy = parsePolicy({
  version: 1,
  cash: { buffer: { amount: "5000.00" } },
  allocation: {
    drift_band: "0.05",
    buckets: {
      us_stocks: { target: "0.55", tickers: ["VTI", "VOO"], security_types: ["equity"] },
      intl_stocks: { target: "0.30", tickers: ["VXUS"] },
      bonds_and_cash: { target: "0.10", tickers: ["BND"], cash_equivalents: true },
      commodities: { target: "0.05", tickers: ["PALL"] },
    },
  },
}).policy;

const catalog: SecurityCatalog = parseSecurityCatalog({
  version: 1,
  classes: {
    us_stocks: "US stocks",
    intl_stocks: "International stocks",
    bonds: "Bonds",
    cash: "Cash",
    commodities: "Commodities",
  },
  default_buy: { us_stocks: "VTI", intl_stocks: "VXUS", bonds: "BND" },
  securities: [
    {
      ticker: "GRID",
      name: "Grid ETF",
      mix: { us_stocks: "0.25", intl_stocks: "0.75" },
      source_url: "https://example.com/grid",
      mix_as_of: "2026-10-01",
      verified_on: "2026-11-03",
    },
    { ticker: "RIO", name: "Rio Tinto (ADR)", mix: { intl_stocks: "1" } },
    { ticker: "VMFXX", name: "Money market", mix: { cash: "1" } },
  ],
});

function holding(
  account_id: string,
  ticker: string,
  type: string,
  value: string,
  cost_basis: string | null = null,
): SnapshotHolding {
  return {
    account_id,
    security_id: `sec-${ticker}`,
    ticker_symbol: ticker,
    security_name: ticker,
    is_cash_equivalent: false,
    security_type: type,
    institution_value: value,
    cost_basis,
  };
}

function snapshot(holdings: SnapshotHolding[]): Snapshot {
  const acct = (id: string, name: string, subtype: string) => ({
    id,
    name,
    type: "investment",
    subtype,
    currency: "USD",
    current: null,
    available: null,
    balance_as_of: null,
  });
  return {
    today: "2026-11-03",
    investing_enabled: true,
    accounts: [acct(TAXABLE, "Brokerage", "brokerage"), acct(IRA, "IRA", "ira")],
    liabilities: [],
    holdings,
    spending: [],
  };
}

describe("allocation", () => {
  it("splits a global fund across buckets and puts foreign ADRs in international", () => {
    const [grid, rio, nvda] = classifyHoldings(
      policy.allocation ?? { drift_band: "0.05", buckets: {} },
      [
        holding(TAXABLE, "GRID", "etf", "100"),
        holding(TAXABLE, "RIO", "equity", "100"),
        holding(TAXABLE, "NVDA", "equity", "100"),
      ],
      catalog,
    );
    expect(grid?.parts.map((p) => [p.bucket, p.fraction.toString()])).toEqual([
      ["us_stocks", "0.25"],
      ["intl_stocks", "0.75"],
    ]);
    expect(rio?.parts.map((p) => p.bucket)).toEqual(["intl_stocks"]);
    expect(nvda).toMatchObject({ via: "security_type", parts: [{ bucket: "us_stocks" }] });
  });

  it("counts a catalog cash fund in the bucket whose name covers cash", () => {
    const [mm] = classifyHoldings(
      policy.allocation ?? { drift_band: "0.05", buckets: {} },
      [holding(TAXABLE, "VMFXX", "mutual fund", "100")],
      catalog,
    );
    expect(mm?.parts.map((p) => p.bucket)).toEqual(["bonds_and_cash"]);
  });

  it("counts a ticker-less 401(k) fund by the plan lineup's recorded mix", () => {
    const fund = (name: string, plan_mix?: Record<string, string>): SnapshotHolding => ({
      account_id: IRA,
      ticker_symbol: null,
      security_name: name,
      is_cash_equivalent: false,
      security_type: "mutual fund",
      institution_value: "100",
      ...(plan_mix && { plan_mix }),
    });
    const [intl, smallMid, unknown] = classifyHoldings(
      policy.allocation ?? { drift_band: "0.05", buckets: {} },
      [
        fund("The International Equity Index Fund", { intl_stocks: "1" }),
        fund("The U.S. Small/Mid Cap Equity Index Fund", { "us_stocks.small_mid": "1" }),
        fund("Some Fund Not In The Lineup"),
      ],
      catalog,
    );
    expect(intl).toMatchObject({ via: "plan_lineup", parts: [{ bucket: "intl_stocks" }] });
    expect(smallMid).toMatchObject({ via: "plan_lineup", parts: [{ bucket: "us_stocks" }] });
    expect(unknown?.via).toBeNull();
  });

  it("reports percentages and rebalancing moves, never dollar amounts", () => {
    const s = snapshot([
      // US: 70 of 100; intl 20; bonds 0; commodities 10.
      holding(TAXABLE, "VOO", "etf", "3000", "2000"),
      holding(TAXABLE, "NVDA", "equity", "2000", "2500"),
      holding(IRA, "VTI", "etf", "2000", "1000"),
      holding(TAXABLE, "VXUS", "etf", "2000", "1900"),
      holding(TAXABLE, "PALL", "etf", "1000", "800"),
      holding(TAXABLE, "MYSTERY", "etf", "1000"),
    ]);
    const r = buildAllocationReport(policy, s, catalog);
    if ("empty" in r) throw new Error("expected a report");
    expect(r.rebalance).toBe(true);
    expect(r.buckets.map((b) => [b.key, b.current, b.target, b.drift, b.status])).toEqual([
      ["us_stocks", "70.0", "55.0", "15.0", "over"],
      ["intl_stocks", "20.0", "30.0", "-10.0", "under"],
      ["bonds_and_cash", "0.0", "10.0", "-10.0", "under"],
      ["commodities", "10.0", "5.0", "5.0", "ok"],
    ]);
    // MYSTERY is left out of the percentages and reported on its own.
    expect(r.unclassified).toMatchObject({ percent: "9.1", holdings: [{ ticker: "MYSTERY" }] });

    // Largest gap first. The IRA sells first (no tax), then the loss, then the smallest gain.
    expect(r.moves).toEqual([
      expect.objectContaining({
        from: "us_stocks",
        to: "intl_stocks",
        points: "10.0",
        buy: { ticker: "VXUS", name: "VXUS", held: true },
        sell: [expect.objectContaining({ ticker: "VTI", percent_of_position: "50", gain: "100" })],
      }),
      expect.objectContaining({
        from: "us_stocks",
        to: "bonds_and_cash",
        points: "5.0",
        // BND isn't held: the bucket's first ticker.
        buy: { ticker: "BND", name: null, held: false },
        sell: [expect.objectContaining({ ticker: "VTI", percent_of_position: "25" })],
      }),
      // Commodities is inside its band but over target, so it funds the rest.
      expect.objectContaining({
        from: "commodities",
        to: "bonds_and_cash",
        points: "5.0",
        sell: [expect.objectContaining({ ticker: "PALL", percent_of_position: "50", gain: "25" })],
      }),
    ]);
    expect(r.moves[0]?.sell[0]).toMatchObject({ tax_advantaged: true });
    // Or, without selling: new money goes to the two buckets under target until about a third
    // more has gone in.
    expect(r.new_money).toMatchObject({
      basis: "catch_up",
      catch_up: "33",
      split: [
        { bucket: "intl_stocks", percent: "60", buy: { ticker: "VXUS" } },
        { bucket: "bonds_and_cash", percent: "40", buy: { ticker: "BND" } },
      ],
    });
    expect(r.concentration.single_stocks).toBe("18.2");
    expect(r.notes.some((n) => /left out/.test(n))).toBe(true);

    const text = JSON.stringify(r);
    for (const dollars of ["3000", "2000", "1000", "11000"]) expect(text).not.toContain(dollars);
  });

  it("adds amounts by bucket only for a user who turned them on", () => {
    const s = snapshot([
      holding(TAXABLE, "VTI", "etf", "72"),
      holding(TAXABLE, "VXUS", "etf", "15"),
      holding(TAXABLE, "PALL", "etf", "11"),
      holding(TAXABLE, "BND", "etf", "2"),
      holding(TAXABLE, "MYSTERY", "etf", "5"),
    ]);
    const off = buildAllocationReport(policy, s, catalog);
    if ("empty" in off) throw new Error("expected a report");
    expect(off.amounts).toBeUndefined();

    const r = buildAllocationReport(policy, s, catalog, { amounts: true });
    if ("empty" in r) throw new Error("expected a report");
    expect(r.amounts).toEqual({
      currency: "USD",
      invested: "105.00",
      in_mix: "100.00",
      buckets: {
        us_stocks: "72.00",
        intl_stocks: "15.00",
        bonds_and_cash: "2.00",
        commodities: "11.00",
      },
      sleeve: null,
      unclassified: "5.00",
      // n = 0.23 / 0.60 of the 100 in the mix, unrounded.
      catch_up: "38.33",
    });

    // The page gets the bucket totals, still nothing about single positions.
    const page = allocationForPage({ state: "ready", show_amounts: true, ...r });
    expect(page).toMatchObject({ show_amounts: true, amounts: r.amounts });
    expect(JSON.stringify(page)).not.toMatch(/VTI|MYSTERY/);
  });

  it("sends new money to the buckets under target so they reach it together", () => {
    // 72 / 15 / 11 / 2 against 55 / 30 / 5 / 10.
    const s = snapshot([
      holding(TAXABLE, "VTI", "etf", "72"),
      holding(TAXABLE, "VXUS", "etf", "15"),
      holding(TAXABLE, "PALL", "etf", "11"),
      holding(TAXABLE, "BND", "etf", "2"),
    ]);
    const r = buildAllocationReport(policy, s, catalog);
    if ("empty" in r) throw new Error("expected a report");
    // n = (0.15 + 0.08) / (1 - 0.40); intl gets 0.30(1 + n) - 0.15, bonds 0.10(1 + n) - 0.02.
    expect(r.new_money).toEqual({
      basis: "catch_up",
      catch_up: "38",
      split: [
        { bucket: "intl_stocks", percent: "69", buy: { ticker: "VXUS", name: "VXUS", held: true } },
        {
          bucket: "bonds_and_cash",
          percent: "31",
          buy: { ticker: "BND", name: "BND", held: true },
        },
      ],
    });
  });

  it("follows the targets with new money once nothing is under target", () => {
    const s = snapshot([
      holding(TAXABLE, "VTI", "etf", "55"),
      holding(TAXABLE, "VXUS", "etf", "30"),
      holding(TAXABLE, "BND", "etf", "10"),
      holding(TAXABLE, "PALL", "etf", "5"),
    ]);
    const r = buildAllocationReport(policy, s, catalog);
    if ("empty" in r) throw new Error("expected a report");
    expect(r.new_money.basis).toBe("target");
    expect(r.new_money.catch_up).toBeNull();
    expect(r.new_money.split.map((x) => [x.bucket, x.percent])).toEqual([
      ["us_stocks", "55"],
      ["intl_stocks", "30"],
      ["bonds_and_cash", "10"],
      ["commodities", "5"],
    ]);
  });

  it("keeps a bucket marked taxable_new_money: false out of the new-money split", () => {
    const located = parsePolicy({
      version: 1,
      cash: { buffer: { amount: "5000.00" } },
      allocation: {
        drift_band: "0.05",
        new_money_max_share: "0.6",
        buckets: {
          us_stocks: { target: "0.60", tickers: ["VTI"], security_types: ["equity"] },
          intl_stocks: { target: "0.30", tickers: ["VXUS"] },
          bonds_and_cash: { target: "0.10", tickers: ["BND"], taxable_new_money: false },
        },
      },
    }).policy;
    // International and bonds are both under target; only stocks take new money, and the cap
    // hands international's excess to US stocks.
    const catchUp = buildAllocationReport(
      located,
      snapshot([
        holding(TAXABLE, "VTI", "etf", "71"),
        holding(TAXABLE, "VXUS", "etf", "20"),
        holding(IRA, "BND", "etf", "9"),
      ]),
      catalog,
    );
    if ("empty" in catchUp) throw new Error("expected a report");
    expect(catchUp.new_money.split.map((x) => [x.bucket, x.percent])).toEqual([
      ["us_stocks", "40"],
      ["intl_stocks", "60"],
    ]);
    // On target: 2 to 1 by the stock targets, not held to the catch-up cap.
    const onTarget = buildAllocationReport(
      located,
      snapshot([
        holding(TAXABLE, "VTI", "etf", "60"),
        holding(TAXABLE, "VXUS", "etf", "30"),
        holding(IRA, "BND", "etf", "10"),
      ]),
      catalog,
    );
    if ("empty" in onTarget) throw new Error("expected a report");
    expect(onTarget.new_money.basis).toBe("target");
    expect(onTarget.new_money.split.map((x) => [x.bucket, x.percent])).toEqual([
      ["us_stocks", "67"],
      ["intl_stocks", "33"],
    ]);
  });

  it("counts a hand-entered holding in its asset class", () => {
    const s: Snapshot = {
      ...snapshot([holding(TAXABLE, "VTI", "etf", "90")]),
      manual_holdings: [
        {
          id: "m1",
          name: "TreasuryDirect",
          asset_class: "bonds",
          value: "10",
          as_of: "2026-11-01",
        },
      ],
    };
    const r = buildAllocationReport(policy, s, catalog);
    if ("empty" in r) throw new Error("expected a report");
    expect(r.buckets.find((b) => b.key === "bonds_and_cash")?.current).toBe("10.0");
    expect(r.unclassified.percent).toBe("0.0");
    const page = JSON.stringify(allocationForPage({ state: "ready", ...r }));
    expect(page).not.toContain("TreasuryDirect");
  });

  it("gives the page buckets and where new money goes, but no positions, gains or sells", () => {
    const s = snapshot([
      holding(TAXABLE, "VOO", "etf", "3000", "2000"),
      holding(TAXABLE, "NVDA", "equity", "2000", "2500"),
      holding(TAXABLE, "VXUS", "etf", "1000"),
      holding(TAXABLE, "MYSTERY", "etf", "1000"),
    ]);
    const r = buildAllocationReport(policy, s, catalog);
    if ("empty" in r) throw new Error("expected a report");
    const page = allocationForPage({ state: "ready", ...r });
    const text = JSON.stringify(page);
    for (const hidden of ["NVDA", "MYSTERY", "gain", "percent_of_position", "largest", "sell"]) {
      expect(text).not.toContain(hidden);
    }
    expect(page).toMatchObject({
      buckets: expect.arrayContaining([expect.objectContaining({ key: "us_stocks" })]),
      new_money: {
        basis: "catch_up",
        split: expect.arrayContaining([
          expect.objectContaining({
            bucket: "intl_stocks",
            buy: expect.objectContaining({ ticker: "VXUS" }),
          }),
        ]),
      },
      unclassified: { percent: "14.3" },
    });
    expect("moves" in page).toBe(false);
  });

  it("sells losses before gains in a taxable account", () => {
    const s = snapshot([
      holding(TAXABLE, "VOO", "etf", "5000", "2000"),
      holding(TAXABLE, "NVDA", "equity", "3000", "4000"),
      holding(TAXABLE, "VXUS", "etf", "1500"),
      holding(TAXABLE, "BND", "etf", "500"),
    ]);
    const r = buildAllocationReport(policy, s, catalog);
    if ("empty" in r) throw new Error("expected a report");
    const sells = r.moves.flatMap((m) => m.sell.map((x) => x.ticker));
    expect(sells[0]).toBe("NVDA");
    expect(r.moves[0]?.sell[0]?.gain).toBe("-25");
  });

  it("suggests nothing when every bucket is within the band", () => {
    const s = snapshot([
      holding(TAXABLE, "VTI", "etf", "57"),
      holding(TAXABLE, "VXUS", "etf", "28"),
      holding(TAXABLE, "BND", "etf", "10"),
      holding(TAXABLE, "PALL", "etf", "5"),
    ]);
    const r = buildAllocationReport(policy, s, catalog);
    if ("empty" in r) throw new Error("expected a report");
    expect(r.rebalance).toBe(false);
    expect(r.moves).toEqual([]);
  });

  it("says why there is no report", () => {
    expect(buildAllocationReport(policy, snapshot([]), catalog)).toMatchObject({
      empty: "no_holdings",
    });
  });

  it("states check_policy drift in points, not dollars", () => {
    const s = snapshot([
      holding(TAXABLE, "VTI", "etf", "8000"),
      holding(TAXABLE, "VXUS", "etf", "2000"),
    ]);
    const us = evaluatePolicy(policy, s, catalog).find((f) => f.key === "allocation:us_stocks");
    expect(us?.summary).toBe("us_stocks: 80.0% vs 55.0% target, 25.0 points over.");
  });

  it("ships a valid security catalog", async () => {
    const shipped = await loadSecurityCatalogFile("catalog/securities.json");
    expect(shipped.securities.length).toBeGreaterThan(10);
    for (const t of Object.values(shipped.default_buy)) {
      expect(shipped.securities.some((s) => s.ticker === t)).toBe(true);
    }
  });
});

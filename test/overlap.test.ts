import { describe, expect, it } from "vitest";
import type { PlaidHolding } from "../src/plaid/gateway.js";
import { evaluatePolicy } from "../src/policy/engine.js";
import { parsePolicy } from "../src/policy/policy.js";
import type { Snapshot, SnapshotAccount, SnapshotHolding } from "../src/policy/snapshot.js";
import {
  allocationForPage,
  buildAllocationReport,
  isTaxAdvantaged,
} from "../src/portfolio/allocation.js";
import { findOverlaps } from "../src/portfolio/overlap.js";
import { parseSecurityCatalog, targetDateMix } from "../src/portfolio/securityCatalog.js";
import { mergeLots } from "../src/sync/syncItem.js";

const PLAN = "00000000-0000-4000-8000-000000000021";
const PCRA = "00000000-0000-4000-8000-000000000022";
const OTHER = "00000000-0000-4000-8000-000000000023";

const policy = parsePolicy({
  version: 1,
  cash: { buffer: { amount: "5000.00" } },
  allocation: {
    drift_band: "0.05",
    buckets: {
      us_stocks: { target: "0.55", tickers: ["VTI"], security_types: ["equity"] },
      intl_stocks: { target: "0.30", tickers: ["VXUS"] },
      bonds_and_cash: { target: "0.15", tickers: ["BND"], cash_equivalents: true },
    },
  },
}).policy;

const catalog = parseSecurityCatalog({
  version: 1,
  classes: { us_stocks: "US stocks", intl_stocks: "International stocks", bonds: "Bonds" },
  default_buy: { us_stocks: "VTI" },
  securities: [{ ticker: "SWPPX", name: "Schwab S&P 500 Index Fund", mix: { us_stocks: "1" } }],
  target_date: {
    stocks: [
      { years: 25, share: "0.9" },
      { years: 0, share: "0.5" },
      { years: -7, share: "0.3" },
    ],
    stock_mix: { us_stocks: "0.6", intl_stocks: "0.4" },
    rest: "bonds",
    source_url: "https://example.com/glide",
    mix_as_of: "2025-12-31",
    verified_on: "2026-11-04",
  },
});

function account(
  id: string,
  name: string,
  institution: string,
  subtype: string,
  current: string,
  official_name: string | null = null,
): SnapshotAccount {
  return {
    id,
    name,
    official_name,
    institution_name: institution,
    type: "investment",
    subtype,
    currency: "USD",
    current,
    available: null,
    balance_as_of: null,
  };
}

function position(
  account_id: string,
  name: string,
  ticker: string | null,
  type: string,
  value: string,
): SnapshotHolding {
  return {
    account_id,
    security_id: `sec-${ticker ?? name}`,
    ticker_symbol: ticker,
    security_name: name,
    is_cash_equivalent: false,
    security_type: type,
    institution_value: value,
    cost_basis: null,
  };
}

// A 401(k) whose recordkeeper shows the brokerage window as one lump, and the brokerage that
// holds the window as its own account with the real fund.
function planWithWindow(windowValue = "3000"): Snapshot {
  return {
    today: "2026-11-04",
    investing_enabled: true,
    accounts: [
      account(
        PLAN,
        "Acme Retirement Savings Plan",
        "Principal Financial Group - Participant Logon",
        "stock plan",
        "10000",
        "Prft Shr 401(K) Def Thrift",
      ),
      account(PCRA, "PCRA Trust", "Charles Schwab", "ira", "3000"),
    ],
    liabilities: [],
    holdings: [
      position(PLAN, "The 2055 Retirement Fund", null, "mutual fund", "7000"),
      position(PLAN, "Self-Directed Brokerage Account", null, "equity", windowValue),
      position(PCRA, "Schwab S&P 500 Index Fd", "SWPPX", "mutual fund", "3000"),
    ],
    spending: [],
  };
}

describe("overlapping accounts", () => {
  it("finds a 401(k) brokerage window that is also linked as its own account", () => {
    const s = planWithWindow("2950");
    expect(findOverlaps(s.accounts, s.holdings)).toEqual([
      {
        account_id: PLAN,
        account_name: "Acme Retirement Savings Plan",
        institution_name: "Principal Financial Group - Participant Logon",
        security_id: "sec-Self-Directed Brokerage Account",
        security_name: "Self-Directed Brokerage Account",
        same_as_account_id: PCRA,
        same_as_account_name: "PCRA Trust",
        same_as_institution_name: "Charles Schwab",
      },
    ]);
  });

  it("leaves positions alone when the value or the name doesn't match", () => {
    const off = planWithWindow("2500");
    expect(findOverlaps(off.accounts, off.holdings)).toEqual([]);
    // Same value as a whole account, but an ordinary fund in an ordinary account.
    const plain: Snapshot = {
      ...planWithWindow(),
      accounts: [
        account(PLAN, "Brokerage", "Vanguard", "brokerage", "4000"),
        account(OTHER, "Roth IRA", "Robinhood", "roth", "1000"),
      ],
      holdings: [
        position(PLAN, "Vanguard Total Stock Market ETF", "VTI", "etf", "1000"),
        position(PLAN, "Vanguard Total Bond Market ETF", "BND", "etf", "3000"),
        position(OTHER, "Vanguard Total International Stock ETF", "VXUS", "etf", "1000"),
      ],
    };
    expect(findOverlaps(plain.accounts, plain.holdings)).toEqual([]);
  });

  it("counts the window once in the allocation and says so on the page", () => {
    const r = buildAllocationReport(policy, planWithWindow(), catalog);
    if ("empty" in r) throw new Error("expected a report");
    // 2055 fund (7000): 90% stocks, 60/40 US/intl -> 3780 US, 2520 intl, 700 bonds.
    // SWPPX (3000) US. Total 10000, not 13000.
    expect(r.buckets.map((b) => [b.key, b.current])).toEqual([
      ["us_stocks", "67.8"],
      ["intl_stocks", "25.2"],
      ["bonds_and_cash", "7.0"],
    ]);
    expect(r.unclassified.percent).toBe("0.0");
    expect(r.concentration.single_stocks).toBe("0.0");
    expect(r.counted_once.map((o) => o.same_as_account_id)).toEqual([PCRA]);
    const page = allocationForPage({ state: "ready", ...r });
    expect(page).toMatchObject({
      counted_once: [
        {
          account: "PCRA Trust",
          institution: "Charles Schwab",
          inside: "Acme Retirement Savings Plan",
          inside_institution: "Principal Financial Group - Participant Logon",
        },
      ],
    });
    expect(JSON.stringify(page)).not.toContain("3000");
  });

  it("counts the window once in the policy check", () => {
    const us = evaluatePolicy(policy, planWithWindow(), catalog).find(
      (f) => f.key === "allocation:us_stocks",
    );
    expect(us?.numbers).toMatchObject({ total: "10000.00", weight: "0.6780" });
  });
});

describe("target-date funds", () => {
  it("splits by years to the target year along the glide path", () => {
    const at = (name: string) =>
      Object.fromEntries(
        Object.entries(targetDateMix(catalog, name, 2026) ?? {}).map(([k, v]) => [k, v.toFixed(4)]),
      );
    expect(at("The 2055 Retirement Fund")).toEqual({
      us_stocks: "0.5400",
      intl_stocks: "0.3600",
      bonds: "0.1000",
    });
    // 14 years out: 50% + 40% * 14/25 = 72.4% stocks.
    expect(at("LifePath Index 2040 Fund")).toEqual({
      us_stocks: "0.4344",
      intl_stocks: "0.2896",
      bonds: "0.2760",
    });
    expect(targetDateMix(catalog, "Treasury Note 2030", 2026)).toBeNull();
  });
});

describe("tax-advantaged accounts", () => {
  it("knows a 401(k) the institution calls a stock plan", () => {
    expect(
      isTaxAdvantaged({
        subtype: "stock plan",
        name: "Retirement Savings Plan",
        official_name: "Prft Shr 401(K) Def Thrift",
      }),
    ).toBe(true);
    expect(isTaxAdvantaged({ subtype: "stock plan", name: "Acme Corporation" })).toBe(false);
  });
});

describe("holdings sync", () => {
  it("merges lots of the same security in one account", () => {
    const lot = (quantity: string, value: string, costBasis: string | null): PlaidHolding => ({
      accountId: "acc",
      securityId: "axp",
      quantity,
      institutionPrice: "300",
      institutionValue: value,
      costBasis,
      currency: "USD",
    });
    expect(mergeLots([lot("10", "3000", "2000"), lot("5", "1500", null)])).toEqual([
      {
        accountId: "acc",
        securityId: "axp",
        quantity: "15",
        institutionPrice: "300",
        institutionValue: "4500",
        costBasis: null,
        currency: "USD",
      },
    ]);
    expect(mergeLots([lot("1", "300", "250"), lot("1", "300", "260")])[0]?.costBasis).toBe("510");
  });
});

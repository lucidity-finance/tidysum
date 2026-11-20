import { describe, expect, it } from "vitest";
import { parsePolicy, STYLE_IDS } from "../src/policy/policy.js";
import {
  applyStyle,
  changesBetween,
  describeMix,
  glance,
  glidePath,
  listStyles,
  STYLES,
  styleStatus,
} from "../src/policy/styles.js";

const SLEEVE_ID = "00000000-0000-4000-8000-000000000009";

/** An owner's own rules: tickers, asset location, a research sleeve, accounts and limits. */
const mine = parsePolicy({
  version: 1,
  cash: { buffer: { amount: "5000.00" }, tolerance: "500.00", account_ids: [SLEEVE_ID] },
  cards: { pay_statement_in_full: true },
  allocation: {
    drift_band: "0.05",
    new_money_max_share: "0.6",
    buckets: {
      us_stocks: { target: "0.60", tickers: ["VTI", "FXAIX"] },
      intl_stocks: { target: "0.30", tickers: ["VXUS"] },
      bonds_and_cash: { target: "0.10", tickers: ["BND"], taxable_new_money: false },
      commodities: { target: "0", tickers: ["PALL", "GLD"] },
    },
  },
  research_sleeve: { cap: "0.05", tickers: ["NVDA"] },
  limits: { order_types: ["limit"], max_action_amount: "2500.00" },
}).policy;

describe("money styles", () => {
  it("has one preset per style id, each a valid policy, with sources", () => {
    expect(STYLES.map((s) => s.id).sort()).toEqual([...STYLE_IDS].sort());
    for (const s of STYLES) {
      const p = applyStyle(null, s.id, { age: 40 });
      expect(p.style?.id).toBe(s.id);
      expect(s.sources.length).toBeGreaterThan(0);
      expect(s.rules.length).toBeGreaterThan(0);
    }
  });

  it("fills in the style's rules and keeps the owner's accounts, limits and sleeve", () => {
    const p = applyStyle(mine, "debt_free_first");
    expect(p.cash).toMatchObject({
      buffer: { months_of_spending: 3 },
      buffer_while_in_debt: { amount: "1000.00" },
      tolerance: "500.00",
      account_ids: [SLEEVE_ID],
    });
    expect(p.cards.avoid_credit_cards).toBe(true);
    expect(p.debt.extra_payments).toBe("smallest_balance");
    expect(describeMix(p.allocation)).toBe("75% US stocks, 25% international stocks");
    expect(p.research_sleeve).toEqual(mine.research_sleeve);
    expect(p.limits).toEqual(mine.limits);
    expect(p.allocation?.new_money_max_share).toBe("0.6");
    // The owner's extra fund stays first in its bucket, and asset location is kept.
    expect(p.allocation?.buckets.us_stocks?.tickers.slice(0, 2)).toEqual(["VTI", "FXAIX"]);
    expect(p.allocation?.buckets.bonds_and_cash?.taxable_new_money).toBe(false);
  });

  it("holds your age in bonds for Index and chill, and needs the age", () => {
    expect(() => applyStyle(mine, "index_and_chill")).toThrow(/age/);
    const p = applyStyle(mine, "index_and_chill", { age: 30 });
    expect(p.style).toEqual({ id: "index_and_chill", age: 30 });
    const t = Object.fromEntries(
      Object.entries(p.allocation?.buckets ?? {}).map(([k, b]) => [k, b.target]),
    );
    expect(t).toEqual({
      us_stocks: "0.42",
      intl_stocks: "0.28",
      bonds_and_cash: "0.3",
      commodities: "0",
    });
  });

  it("splits All weather into its five sleeves without listing a ticker twice", () => {
    const p = applyStyle(mine, "all_weather");
    expect(describeMix(p.allocation)).toBe(
      "30% US stocks, 40% long treasuries, 15% intermediate treasuries, 7.5% gold, 7.5% commodities",
    );
    const listed = Object.values(p.allocation?.buckets ?? {}).flatMap((b) =>
      b.tickers.map((t) => t.toUpperCase()),
    );
    expect(new Set(listed).size).toBe(listed.length);
    // GLD moved from the owner's commodities bucket to gold.
    expect(p.allocation?.buckets.gold?.tickers).toContain("GLD");
    expect(p.allocation?.buckets.commodities?.tickers).not.toContain("GLD");
    // All weather has no view on cash or debt: the owner's stay.
    expect(p.cash.buffer).toEqual({ amount: "5000.00" });
  });

  it("leaves the mix alone for Safety first, which has none", () => {
    const p = applyStyle(mine, "safety_first");
    expect(p.allocation).toEqual(mine.allocation);
    expect(p.cash.buffer).toEqual({ months_of_spending: 8 });
  });

  it("says what changed in plain words, and what the owner tweaked since", () => {
    const p = applyStyle(mine, "adviser_standard", { age: 30 });
    expect(changesBetween(mine, p)).toEqual(
      expect.arrayContaining([
        { rule: "Cash buffer", from: "$5,000", to: "3 months of spending" },
        { rule: "Spare cash", from: "stays as cash", to: "goes to the highest-rate debt" },
        {
          rule: "Target mix",
          from: "60% US stocks, 30% international stocks, 10% bonds and cash",
          to: "54% US stocks, 36% international stocks, 10% bonds and cash",
        },
      ]),
    );
    expect(styleStatus(p)).toMatchObject({ id: "adviser_standard", age: 30, tweaks: [] });
    const tweaked = parsePolicy({ ...p, cash: { ...p.cash, buffer: { amount: "9000.00" } } });
    expect(styleStatus(tweaked.policy)?.tweaks).toEqual([
      { rule: "Cash buffer", from: "3 months of spending", to: "$9,000" },
    ]);
    // Rules set by hand, with no style: the owner's own.
    expect(styleStatus(mine)).toBeNull();
  });

  it("follows Vanguard Target Retirement's glide path for Adviser standard", () => {
    expect(() => applyStyle(mine, "adviser_standard")).toThrow(/age/);
    const stocks = (age: number) => glidePath(age).times(100).toString();
    // 90% until 40, 1.6 points a year to 50% at 65, then to 30% at 72 and after.
    expect([25, 40, 45, 50, 55, 60, 65, 70, 72, 85].map(stocks)).toEqual([
      "90",
      "90",
      "82",
      "74",
      "66",
      "58",
      "50",
      "36",
      "30",
      "30",
    ]);
    const targets = (age: number) =>
      Object.fromEntries(
        Object.entries(applyStyle(mine, "adviser_standard", { age }).allocation?.buckets ?? {})
          .filter(([, b]) => b.target !== "0")
          .map(([k, b]) => [k, b.target]),
      );
    // 40% of the stocks abroad, rounded to whole percents that still add up to 100.
    expect(targets(45)).toEqual({ us_stocks: "0.49", intl_stocks: "0.33", bonds_and_cash: "0.18" });
    expect(targets(68)).toEqual({ us_stocks: "0.25", intl_stocks: "0.16", bonds_and_cash: "0.59" });
  });

  it("reads a policy filled from the retired Classic 60/40 as the owner's own rules", () => {
    const old = parsePolicy({ ...mine, style: { id: "classic_60_40" } }).policy;
    expect(old.style).toBeUndefined();
    expect(old.allocation).toEqual(mine.allocation);
    expect(styleStatus(old)).toBeNull();
  });

  it("sums a policy up at a glance for the cards", () => {
    expect(glance(applyStyle(mine, "debt_free_first"))).toEqual({
      mix: [
        { key: "us_stocks", label: "US stocks", percent: "75" },
        { key: "intl_stocks", label: "Intl stocks", percent: "25" },
      ],
      cash: "3-month cushion",
      while_in_debt: "$1,000 until debt-free",
      debt: "Smallest debt first",
      cards: "No credit cards",
    });
    expect(glance(mine)).toMatchObject({ cash: "$5,000 cushion", debt: null, cards: null });
  });

  it("lists every style with its changes, and asks for an age where it is needed", () => {
    const r = listStyles(mine);
    expect(r.current).toBeNull();
    expect(r.note).toMatch(/isn't affiliated/);
    const chill = r.styles.find((s) => s.id === "index_and_chill");
    expect(chill?.changes).toBeNull();
    // Only the mix waits for the age.
    expect(chill?.result).toMatchObject({ mix: null, cash: "6-month cushion" });
    expect(r.mine?.mix?.map((m) => m.percent)).toEqual(["60", "30", "10"]);
    expect(listStyles(mine, { age: 40 }).styles.every((s) => Array.isArray(s.changes))).toBe(true);
  });
});

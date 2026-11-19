import { describe, expect, it } from "vitest";
import { evaluatePolicy, proposalCategory, validateProposal } from "../src/policy/engine.js";
import { parsePolicy } from "../src/policy/policy.js";
import type { Snapshot } from "../src/policy/snapshot.js";

const CHECKING = "00000000-0000-4000-8000-000000000001";
const SAVINGS = "00000000-0000-4000-8000-000000000002";
const CARD = "00000000-0000-4000-8000-000000000003";
const BROKERAGE = "00000000-0000-4000-8000-000000000004";

const base = {
  version: 1,
  cash: { buffer: { amount: "5000.00" }, tolerance: "500" },
  allocation: {
    drift_band: "0.05",
    buckets: {
      us: { target: "0.6", tickers: ["VTI"] },
      intl: { target: "0.3", tickers: ["vxus"] },
      bonds: { target: "0.1", tickers: ["BND"], cash_equivalents: true },
    },
  },
};

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  const acct = (id: string, name: string, type: string, subtype: string, current: string) => ({
    id,
    name,
    type,
    subtype,
    currency: "USD",
    current,
    available: null,
    balance_as_of: "2026-10-30 12:00:00+00",
  });
  return {
    today: "2026-10-30",
    investing_enabled: true,
    accounts: [
      acct(CHECKING, "Checking", "depository", "checking", "3000.10"),
      acct(SAVINGS, "Savings", "depository", "savings", "9000.00"),
      acct(CARD, "Card", "credit", "credit card", "410.00"),
      acct(BROKERAGE, "Brokerage", "investment", "brokerage", "10000.00"),
    ],
    liabilities: [
      {
        account_id: CARD,
        name: "Card",
        kind: "credit",
        apr_percentage: "24.99",
        last_statement_balance: "350.00",
        minimum_payment: "25.00",
        next_payment_due_date: "2026-11-15",
        current_balance: "410.00",
        interest_charged_365d: "0",
      },
    ],
    holdings: [
      {
        account_id: BROKERAGE,
        ticker_symbol: "VTI",
        security_name: "VTI",
        is_cash_equivalent: false,
        security_type: "etf",
        institution_value: "7000.00",
      },
      {
        account_id: BROKERAGE,
        ticker_symbol: "VXUS",
        security_name: "VXUS",
        is_cash_equivalent: false,
        security_type: "etf",
        institution_value: "2500.00",
      },
      {
        account_id: BROKERAGE,
        ticker_symbol: null,
        security_name: "Cash sweep",
        is_cash_equivalent: true,
        security_type: "cash",
        institution_value: "500.00",
      },
    ],
    spending: [
      { month: "2026-07", outflow: "2000.00" },
      { month: "2026-08", outflow: "2500.00" },
      { month: "2026-09", outflow: "3000.00" },
    ],
    ...over,
  };
}

const byCheck = (findings: ReturnType<typeof evaluatePolicy>, check: string) =>
  findings.filter((f) => f.check === check);

describe("policy file", () => {
  it("parses the example policy and versions it by content, not formatting", async () => {
    const { loadPolicyFile } = await import("../src/policy/policy.js");
    const example = await loadPolicyFile("policy.example.json");
    expect(example.policy.cash.buffer).toEqual({ amount: "5000.00" });
    expect(example.policy.limits.order_types).toEqual(["limit"]);
    const a = parsePolicy(base);
    const reordered = parsePolicy({ allocation: base.allocation, cash: base.cash, version: 1 });
    expect(a.versionId).toBe(reordered.versionId);
    expect(parsePolicy({ ...base, cash: { buffer: { amount: "6000" } } }).versionId).not.toBe(
      a.versionId,
    );
  });

  it("rejects targets that don't add up, floats and unknown keys", () => {
    const bad = { ...base, allocation: { buckets: { us: { target: "0.5", tickers: [] } } } };
    expect(() => parsePolicy(bad)).toThrow(/add up to 1/);
    expect(() => parsePolicy({ ...base, cash: { buffer: { amount: 5000 } } })).toThrow(
      /cash.buffer/,
    );
    expect(() => parsePolicy({ ...base, autopilot: true })).toThrow();
  });
});

describe("policy checks", () => {
  it("flags cash above the buffer with the numbers it used", () => {
    const [cash] = byCheck(evaluatePolicy(parsePolicy(base).policy, snapshot()), "cash_buffer");
    expect(cash).toMatchObject({ status: "action", amount: "7000.10" });
    expect(cash?.numbers).toMatchObject({ liquid: "12000.10", buffer: "5000.00" });
  });

  it("counts the lower of current and available balance", () => {
    const s = snapshot();
    const checking = s.accounts[0];
    if (checking) checking.available = "2500.10";
    const [cash] = byCheck(evaluatePolicy(parsePolicy(base).policy, s), "cash_buffer");
    expect(cash?.amount).toBe("6500.10");
    // Chase reports available above current (overdraft line); that isn't cash.
    if (checking) checking.available = "8364.04";
    const [capped] = byCheck(evaluatePolicy(parsePolicy(base).policy, s), "cash_buffer");
    expect(capped?.amount).toBe("7000.10");
  });

  it("computes a months-of-spending buffer, and warns without history", () => {
    const months = { ...base, cash: { buffer: { months_of_spending: 3 } } };
    const [cash] = byCheck(evaluatePolicy(parsePolicy(months).policy, snapshot()), "cash_buffer");
    expect(cash?.numbers).toMatchObject({ average_monthly_spending: "2500.00", buffer: "7500.00" });
    expect(cash?.amount).toBe("4500.10");
    const [none] = byCheck(
      evaluatePolicy(parsePolicy(months).policy, snapshot({ spending: [] })),
      "cash_buffer",
    );
    expect(none?.status).toBe("warning");
  });

  it("asks to clear the card statement, net of payments already made", () => {
    const [card] = byCheck(evaluatePolicy(parsePolicy(base).policy, snapshot()), "card_statement");
    expect(card).toMatchObject({ status: "action", amount: "350.00" });
    const paid = snapshot();
    const l = paid.liabilities[0];
    if (l) l.current_balance = "60.00";
    const [partly] = byCheck(evaluatePolicy(parsePolicy(base).policy, paid), "card_statement");
    expect(partly?.amount).toBe("60.00");
  });

  it("prices a card statement at a year of its APR, or the interest actually charged if more", () => {
    const [card] = byCheck(evaluatePolicy(parsePolicy(base).policy, snapshot()), "card_statement");
    // 350.00 at 24.99% for a year.
    expect(card).toMatchObject({ annual_cost: "87.47", category: "card" });
    const charged = snapshot();
    const l = charged.liabilities[0];
    if (l) l.interest_charged_365d = "120.00";
    const [observed] = byCheck(evaluatePolicy(parsePolicy(base).policy, charged), "card_statement");
    expect(observed?.annual_cost).toBe("120.00");
  });

  it("measures allocation drift and counts cash equivalents where the policy says", () => {
    const findings = byCheck(evaluatePolicy(parsePolicy(base).policy, snapshot()), "allocation");
    const us = findings.find((f) => f.summary.startsWith("us:"));
    const intl = findings.find((f) => f.summary.startsWith("intl:"));
    const bonds = findings.find((f) => f.summary.startsWith("bonds:"));
    expect(us).toMatchObject({ status: "action", amount: "1000.00" });
    expect(us?.numbers).toMatchObject({ weight: "0.7000", drift: "0.1000" });
    // Exactly at the 5-point band is still within it.
    expect(intl?.status).toBe("ok");
    expect(bonds).toMatchObject({ status: "ok", numbers: { value: "500.00", weight: "0.0500" } });
    expect(findings.some((f) => f.status === "warning")).toBe(false);
  });

  it("falls back to the Plaid security type when no bucket lists the ticker", () => {
    const s = snapshot();
    s.holdings.push({
      account_id: BROKERAGE,
      ticker_symbol: "NVDA",
      security_name: "NVIDIA",
      is_cash_equivalent: false,
      security_type: "equity",
      institution_value: "1000.00",
    });
    const plain = byCheck(evaluatePolicy(parsePolicy(base).policy, s), "allocation");
    expect(plain.at(-1)?.numbers).toMatchObject({
      unclassified: [expect.objectContaining({ ticker: "NVDA" })],
    });
    const typed = parsePolicy({
      ...base,
      allocation: {
        ...base.allocation,
        buckets: {
          ...base.allocation.buckets,
          us: { target: "0.6", tickers: ["VTI"], security_types: ["equity"] },
        },
      },
    });
    const findings = byCheck(evaluatePolicy(typed.policy, s), "allocation");
    expect(findings.find((f) => f.summary.startsWith("us:"))?.numbers).toMatchObject({
      value: "8000.00",
    });
    expect(findings.some((f) => f.status === "warning")).toBe(false);
  });

  it("suggests an extra payment to the highest APR only when the policy asks", () => {
    const off = byCheck(evaluatePolicy(parsePolicy(base).policy, snapshot()), "extra_payment");
    expect(off).toEqual([]);
    const on = parsePolicy({ ...base, debt: { extra_payments: "highest_apr" } }).policy;
    // A card paid in full charges no interest, so paying it early saves nothing.
    expect(byCheck(evaluatePolicy(on, snapshot()), "extra_payment")).toEqual([]);
    const [extra] = byCheck(evaluatePolicy(on, withDebts()), "extra_payment");
    // 12000.10 cash - 5000 buffer - 350 statement = 6650.10 spare, capped at the 410 owed.
    expect(extra).toMatchObject({
      amount: "410.00",
      account_ids: [CARD],
      category: "debt",
      annual_cost: "102.46",
    });
  });

  it("pays the smallest debt first with the snowball, mortgage aside", () => {
    const policy = parsePolicy({ ...base, debt: { extra_payments: "smallest_balance" } }).policy;
    const [extra] = byCheck(evaluatePolicy(policy, withDebts()), "extra_payment");
    expect(extra).toMatchObject({ account_ids: [CARD], amount: "410.00" });
    expect(extra?.summary).toMatch(/smallest debt/);
    expect(extra?.numbers).toMatchObject({ order: "smallest_balance" });
  });

  it("keeps the smaller buffer while there is consumer debt", () => {
    const policy = parsePolicy({
      ...base,
      cash: { ...base.cash, buffer_while_in_debt: { amount: "1000.00" } },
      debt: { extra_payments: "smallest_balance" },
    }).policy;
    const inDebt = byCheck(evaluatePolicy(policy, withDebts()), "cash_buffer")[0];
    expect(inDebt?.numbers).toMatchObject({ buffer: "1000.00", while_in_debt: "1000.00" });
    const [extra] = byCheck(evaluatePolicy(policy, withDebts()), "extra_payment");
    // 12000.10 - 1000 starter buffer - 350 statement = 10650.10 spare, capped at 410.
    expect(extra).toMatchObject({ amount: "410.00" });
    // A card paid in full each month is not debt: the full buffer applies.
    const clear = byCheck(evaluatePolicy(policy, snapshot()), "cash_buffer")[0];
    expect(clear?.numbers).toMatchObject({ buffer: "5000.00", fixed: "5000.00" });
  });
});

/** The base snapshot with interest on the card, a student loan and a mortgage. */
function withDebts(): Snapshot {
  const s = snapshot();
  const loan = (account_id: string, kind: string, balance: string, apr: string) => ({
    account_id,
    name: kind,
    kind,
    apr_percentage: apr,
    last_statement_balance: null,
    minimum_payment: null,
    next_payment_due_date: null,
    current_balance: balance,
    interest_charged_365d: "0",
  });
  return {
    ...s,
    liabilities: [
      ...s.liabilities.map((l) => ({ ...l, interest_charged_365d: "40.00" })),
      loan("00000000-0000-4000-8000-000000000005", "student", "9000.00", "5.5"),
      loan("00000000-0000-4000-8000-000000000006", "mortgage", "300.00", "6.5"),
    ],
  };
}

describe("proposal validation", () => {
  const policy = parsePolicy({
    ...base,
    limits: { max_action_amount: "5000", max_proposal_total: "8000" },
  }).policy;

  it("accepts a sweep that keeps the buffer", () => {
    const v = validateProposal(policy, snapshot(), [
      { kind: "transfer", from_account_id: SAVINGS, to_account_id: BROKERAGE, amount: "4000.00" },
      { kind: "payment", from_account_id: CHECKING, to_account_id: CARD, amount: "350.00" },
    ]);
    expect(v.violations).toEqual([]);
    expect(v.numbers).toMatchObject({ cash_out: "4350.00", liquid: "12000.10" });
  });

  it("blocks breaking the buffer, the limits, or overpaying", () => {
    const v = validateProposal(policy, snapshot(), [
      { kind: "transfer", from_account_id: SAVINGS, to_account_id: BROKERAGE, amount: "5000.01" },
      { kind: "transfer", from_account_id: CHECKING, to_account_id: BROKERAGE, amount: "3000.00" },
      { kind: "payment", from_account_id: CHECKING, to_account_id: CARD, amount: "500.00" },
    ]);
    expect(v.violations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/action 1: .* per-action limit/),
        expect.stringMatching(/action 3: 500.00 is more than the 410.00 owed/),
        expect.stringMatching(/total 8500.01 is over the per-proposal limit/),
        expect.stringMatching(/below the 5000.00 buffer/),
      ]),
    );
  });

  it("blocks unknown accounts and money leaving a non-bank account", () => {
    const v = validateProposal(policy, snapshot(), [
      { kind: "transfer", from_account_id: BROKERAGE, to_account_id: CHECKING, amount: "10" },
      {
        kind: "payment",
        from_account_id: CHECKING,
        to_account_id: "00000000-0000-4000-8000-00000000dead",
        amount: "10",
      },
    ]);
    expect(v.violations).toEqual([
      "action 1: money can only leave a bank account",
      expect.stringMatching(/action 2: unknown account/),
    ]);
  });

  it("has no caps when the policy sets none", () => {
    const open = parsePolicy(base).policy;
    const v = validateProposal(open, snapshot(), [
      { kind: "trade", from_account_id: BROKERAGE, side: "buy", symbol: "VTI", amount: "99999" },
    ]);
    expect(v.violations).toEqual([]);
    expect(v.warnings).toEqual([expect.stringMatching(/agentic account/)]);
  });
});

describe("investing is per user", () => {
  const policy = () => parsePolicy(base).policy;
  const trade = {
    kind: "trade" as const,
    from_account_id: BROKERAGE,
    side: "buy" as const,
    symbol: "VTI",
    amount: "100",
  };

  it("skips allocation checks for users without investing", () => {
    const off = evaluatePolicy(policy(), snapshot({ investing_enabled: false }));
    expect(byCheck(off, "allocation")).toEqual([]);
    expect(byCheck(evaluatePolicy(policy(), snapshot()), "allocation").length).toBeGreaterThan(0);
  });

  it("blocks trade proposals for users without investing", () => {
    const v = validateProposal(policy(), snapshot({ investing_enabled: false }), [trade]);
    expect(v.violations).toEqual([expect.stringMatching(/investment advice/)]);
  });

  it("categorizes proposals; any trade makes one securities advice", () => {
    const s = snapshot();
    const pay = {
      kind: "payment" as const,
      from_account_id: CHECKING,
      to_account_id: CARD,
      amount: "1",
    };
    const move = {
      kind: "transfer" as const,
      from_account_id: CHECKING,
      to_account_id: SAVINGS,
      amount: "1",
    };
    expect(proposalCategory(s, [move])).toBe("cash");
    expect(proposalCategory(s, [pay])).toBe("card");
    expect(proposalCategory(s, [move, trade])).toBe("securities");
  });

  it("gives each finding a stable key", () => {
    const keys = evaluatePolicy(policy(), snapshot()).map((f) => f.key);
    expect(keys).toContain("cash_buffer");
    expect(keys).toContain(`card_statement:${CARD}`);
    expect(keys.some((k) => k.startsWith("allocation:"))).toBe(true);
  });
});

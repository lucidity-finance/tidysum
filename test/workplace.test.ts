import Big from "big.js";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, inject, it } from "vitest";
import { carriedBy, newMoneyDraft, stepsFor } from "../src/actions/actions.js";
import { connect } from "../src/db/client.js";
import { account, appUser, item, workplacePlan } from "../src/db/schema.js";
import { connectAgent } from "../src/mcp/agentDb.js";
import { actedOn } from "../src/misallocation/ledger.js";
import type { SnapshotHolding } from "../src/policy/snapshot.js";
import { type AllocationResult, capShares } from "../src/portfolio/allocation.js";
import { loadSecurityCatalogFile } from "../src/portfolio/securityCatalog.js";
import {
  nextYearWindow,
  parseWorkplaceFacts,
  paycheckMirror,
  paychecksLeft,
  paydays,
  rateChange,
  readWorkplacePlans,
  roundedPercents,
  setWorkplacePlan,
  type WorkplaceFacts,
  workplaceFindings,
} from "../src/retirement/workplace.js";

const catalog = await loadSecurityCatalogFile("catalog/securities.json");

const facts = (over: Partial<WorkplaceFacts["contributions"]> = {}, extra: object = {}) =>
  parseWorkplaceFacts({
    plan_name: "Acme 401(k)",
    site_url: "https://plan.example/participant",
    as_of: "2026-11-12",
    pay: { salary: "210000", paychecks_per_year: 24, bonus: "30000" },
    contributions: {
      year: 2026,
      ytd_employee: "16864.13",
      base: { pretax: "12", roth: "0" },
      bonus: { pretax: "12", roth: "12" },
      ...over,
    },
    match: { up_to_percent: "6", rate: "1", true_up: false },
    prefer: "pretax",
    marginal_tax_rate: "0.24",
    paycheck_investments: [
      { fund: "The 2055 Retirement Fund", percent: "50" },
      { fund: "Self-Directed Brokerage Account", percent: "50" },
    ],
    lineup: [
      {
        name: "The 2055 Retirement Fund",
        expense_ratio: "0.27",
        kind: "target_date",
        mix: {
          "us_stocks.large": "0.4628",
          "us_stocks.small_mid": "0.1156",
          intl_stocks: "0.3116",
          bonds: "0.11",
        },
        mix_source: "Principal fact sheet",
        mix_as_of: "2026-09-30",
      },
      {
        name: "U.S. Large Cap Equity Index Fund",
        expense_ratio: "0.01",
        kind: "index",
        mix: { "us_stocks.large": "1" },
      },
      {
        name: "U.S. Small/Mid Cap Equity Index Fund",
        expense_ratio: "0.02",
        kind: "index",
        mix: { "us_stocks.small_mid": "1" },
      },
      {
        name: "International Equity Index Fund",
        expense_ratio: "0.04",
        kind: "index",
        mix: { intl_stocks: "1" },
      },
      {
        name: "International Equity Fund",
        expense_ratio: "0.46",
        kind: "active",
        mix: { intl_stocks: "1" },
      },
      {
        name: "Diversified Bond Index Fund",
        expense_ratio: "0.01",
        kind: "index",
        mix: { bonds: "1" },
      },
      { name: "Self-Directed Brokerage Account", expense_ratio: "0", kind: "brokerage_window" },
    ],
    ...extra,
  });

describe("contribution percent", () => {
  it("counts the paychecks left in the year", () => {
    expect(paychecksLeft("2026-11-12", 24)).toBe(4);
    expect(paychecksLeft("2026-12-20", 24)).toBe(1);
    expect(paychecksLeft("2026-12-31", 24)).toBe(0);
    expect(paychecksLeft("2026-01-01", 26)).toBe(26);
  });

  it("counts real paydays: the 15th and the last day, moved back off weekends", () => {
    const semi = { paychecks_per_year: 24 as const };
    expect(paydays(2026, semi)?.slice(-5)).toEqual([
      "2026-10-30", // the 31st is a Saturday
      "2026-11-13", // the 15th is a Sunday
      "2026-11-30",
      "2026-12-15",
      "2026-12-31",
    ]);
    // The day after the Nov 13 paycheck, three are left, not four.
    expect(paychecksLeft("2026-11-14", semi)).toBe(3);
    expect(paychecksLeft("2026-11-13", semi)).toBe(3);
    // Past a 10-day payroll cutoff, Nov 30 can't change any more.
    expect(paychecksLeft("2026-11-21", { ...semi, cutoff_days: 10 })).toBe(2);
    // Every two weeks from a real payday; or the recorded calendar.
    expect(
      paychecksLeft("2026-11-14", { paychecks_per_year: 26, last_pay_date: "2026-11-06" }),
    ).toBe(3);
    expect(
      paychecksLeft("2026-11-14", {
        ...semi,
        pay_dates: ["2026-11-25", "2026-12-10", "2026-12-23"],
      }),
    ).toBe(3);
  });

  it("opens next year's change after this year's last payday, closing before next year's first cutoff", () => {
    expect(nextYearWindow(2026, { paychecks_per_year: 24 })).toEqual({
      not_before: "2027-01-01",
      due_by: "2027-01-05",
    });
    expect(nextYearWindow(2026, { paychecks_per_year: 26 })).toEqual({
      not_before: "2027-01-01",
      due_by: null,
    });
  });

  it("raises it to reach this year's limit with the paychecks left, rounding down", () => {
    const { change } = rateChange(facts(), "2026-11-12");
    // Room 24,500 - 16,864.13 = 7,635.87 over 4 paychecks of 8,750: 21.8%, so 21%.
    expect(change).toMatchObject({
      kind: "raise",
      year: 2026,
      this_year: true,
      current_percent: "12",
      new_percent: "21",
      paychecks: 4,
    });
    // 9 more points of 4 paychecks of 8,750 is 3,150 more pre-tax, at 24%.
    expect(change?.value.toFixed(2)).toBe("756.00");
  });

  it("near year end, lowers next year's so the limit comes with the last paycheck", () => {
    const { change } = rateChange(
      facts({ ytd_employee: "24000", base: { pretax: "24", roth: "0", after_tax: "0" } }),
      "2026-12-20",
    );
    // Next year: 24% of 210,000 + 24% of a 30,000 bonus is far over 25,500. With the bonus
    // first, the limit comes on paycheck 9 of 24, and 15 paychecks lose a 6% match of 8,750.
    expect(change).toMatchObject({
      kind: "lower",
      year: 2027,
      this_year: false,
      new_percent: "10",
      unmatched: 15,
      limit_official: false,
    });
    expect(change?.value.toFixed(2)).toBe("7875.00");
  });

  it("leaves a plan alone that is on course, and says when its numbers are from another year", () => {
    expect(
      rateChange(
        facts({ ytd_employee: "21350", base: { pretax: "9", roth: "0", after_tax: "0" } }),
        "2026-11-12",
      ).change,
    ).toBeNull();
    const stale = rateChange(facts({ year: 2025 }), "2026-11-12");
    expect(stale.change).toBeNull();
    expect(stale.warning).toMatch(/recorded for 2025/);
  });

  it("puts the change on a card the agent carries out, Roth bonus moved to pre-tax", () => {
    const acct = "11111111-1111-4111-8111-111111111111";
    const found = workplaceFindings(
      [{ account_id: acct, facts: facts() }],
      [],
      catalog,
      "2026-11-12",
    );
    const rate = found.items.find((m) => m.detector === "retirement_rate");
    expect(rate).toMatchObject({
      key: `retirement_rate:${acct}:2026:raise`,
      category: "securities",
      annual_cost: "756.00",
      action: "Set your Acme 401(k) contributions to 21% for the rest of 2026",
    });
    expect(found.percents).toEqual({ [acct]: "12" });
    const steps = stepsFor(
      { ...(rate as object), detector: "retirement_rate", accountIds: [acct] } as never,
      () => null,
    );
    expect(steps).toEqual([
      {
        text: "In Acme 401(k), set pre-tax contributions to 21% of base pay for the rest of 2026",
        by: "agent",
        needs_you: "Sign-in",
      },
      {
        text: "Make every contribution pre-tax: set Roth to 0% and add it to pre-tax",
        by: "agent",
        needs_you: "Sign-in",
      },
      {
        text: "Check that checking stays above your cash buffer with the smaller paychecks",
        by: "agent",
      },
    ]);
  });
});

describe("plan fund fees", () => {
  const acct = "22222222-2222-4222-8222-222222222222";
  const held = (name: string, value: string): SnapshotHolding => ({
    account_id: acct,
    ticker_symbol: null,
    security_name: name,
    is_cash_equivalent: false,
    security_type: "mutual fund",
    institution_value: value,
  });

  it("copies a target-date fund sleeve by sleeve from its fact sheet", () => {
    const found = workplaceFindings(
      [{ account_id: acct, facts: facts() }],
      [
        held("The 2055 Retirement Fund", "100000"),
        held("Self-Directed Brokerage Account", "50000"),
      ],
      catalog,
      "2026-11-12",
    );
    const fee = found.items.find((m) => m.detector === "fund_fee");
    // 0.4628 x 0.01 + 0.1156 x 0.02 + 0.3116 x 0.04 + 0.11 x 0.01 = 0.020504%, against 0.27%.
    expect(fee).toMatchObject({
      key: `fund_fee:${acct}:2055-retirement-fund`,
      annual_cost: "249.50",
      action: "Swap The 2055 Retirement Fund for the plan's index funds",
      inputs: {
        alternative_expense_ratio: "0.0205",
        paychecks_too: true,
        mix_source: "Principal fact sheet",
        mix_as_of: "2026-09-30",
        copy: [
          {
            label: "US large-cap stocks",
            holds: "46.28",
            fund: "U.S. Large Cap Equity Index Fund",
            percent: 46,
          },
          {
            label: "International stocks",
            holds: "31.16",
            fund: "International Equity Index Fund",
            percent: 31,
          },
          {
            label: "US small- and mid-cap stocks",
            holds: "11.56",
            fund: "U.S. Small/Mid Cap Equity Index Fund",
            percent: 12,
          },
          { label: "Bonds", holds: "11", fund: "Diversified Bond Index Fund", percent: 11 },
        ],
        into: [
          { fund: "U.S. Large Cap Equity Index Fund", percent: 46 },
          { fund: "International Equity Index Fund", percent: 31 },
          { fund: "U.S. Small/Mid Cap Equity Index Fund", percent: 12 },
          { fund: "Diversified Bond Index Fund", percent: 11 },
        ],
      },
    });
    expect(fee?.summary).toContain(
      "holds 46.28% US large-cap stocks, 31.16% international stocks, 11.56% US small- and mid-cap stocks and 11% bonds",
    );
    expect(found.items.filter((m) => m.detector === "fund_fee")).toHaveLength(1);
    expect(found.undecided).toEqual([]);
    expect(found.funds[acct]).toEqual([
      "The 2055 Retirement Fund",
      "Self-Directed Brokerage Account",
    ]);
    const steps = stepsFor(
      { ...(fee as object), detector: "fund_fee", accountIds: [acct] } as never,
      () => null,
    );
    expect(steps[0]?.text).toBe(
      "In Acme 401(k), exchange all of The 2055 Retirement Fund into 46% U.S. Large Cap Equity Index Fund, 31% International Equity Index Fund, 12% U.S. Small/Mid Cap Equity Index Fund, 11% Diversified Bond Index Fund",
    );
    expect(steps[1]?.text).toMatch(/^Stop sending paychecks to The 2055 Retirement Fund/);
  });

  it("asks for a fund's fact sheet instead of guessing what it holds", () => {
    const lineup = (fund: object) => facts({}, { lineup: [fund, ...facts().lineup.slice(1)] });
    const holding = [held("The 2055 Retirement Fund", "100000")];
    const target = { name: "The 2055 Retirement Fund", expense_ratio: "0.27", kind: "target_date" };
    const key = `fund_fee:${acct}:2055-retirement-fund`;

    // No mix recorded: no swap, a request for the fact sheet, and the finding left as it was.
    const unknown = workplaceFindings(
      [{ account_id: acct, facts: lineup(target) }],
      holding,
      catalog,
      "2026-11-12",
    );
    expect(unknown.items.some((m) => m.detector === "fund_fee")).toBe(false);
    expect(unknown.undecided).toEqual([key]);
    expect(unknown.warnings.join(" ")).toMatch(/needs what it actually holds, from its fact sheet/);

    // A mix read more than about a year ago is read again first.
    const old = workplaceFindings(
      [{ account_id: acct, facts: facts() }],
      holding,
      catalog,
      "2027-12-01",
    );
    expect(old.items.some((m) => m.detector === "fund_fee")).toBe(false);
    expect(old.undecided).toEqual([key]);

    // A sleeve the plan has no fund for isn't papered over with a neighbouring one.
    const noSmall = facts(
      {},
      { lineup: facts().lineup.filter((f) => !f.name.includes("Small/Mid")) },
    );
    const gap = workplaceFindings(
      [{ account_id: acct, facts: noSmall }],
      holding,
      catalog,
      "2026-11-12",
    );
    expect(gap.items.some((m) => m.detector === "fund_fee")).toBe(false);
    expect(gap.undecided).toEqual([]);
    expect(gap.warnings).toContain(
      "Acme 401(k) has no fund holding only US small- and mid-cap stocks, so The 2055 Retirement Fund can't be copied exactly; Tidysum leaves it as it is.",
    );

    // A target-date fund's mix needs its source and date.
    expect(() => lineup({ ...target, mix: { intl_stocks: "1" } })).toThrow(
      /needs mix_source and mix_as_of/,
    );
  });

  it("counts a fund swap as done only once the fund is gone", () => {
    const row = {
      detector: "fund_fee",
      inputs: { fund: "The 2055 Retirement Fund" },
      accountIds: [acct],
      productId: null,
    };
    const base = { card_ids: [], cash_institutions: [] };
    expect(actedOn(row, { ...base, workplace_funds: { [acct]: [] } })).toBe(true);
    // Still held, the finding went away for another reason: withdrawn, not acted on.
    expect(
      actedOn(row, { ...base, workplace_funds: { [acct]: ["The 2055 Retirement Fund"] } }),
    ).toBe(false);
  });

  it("moves the brokerage window's funds the plan can copy back into its index funds", () => {
    const pcra = "33333333-3333-4333-8333-333333333333";
    const fund = (ticker: string, name: string, value: string): SnapshotHolding => ({
      account_id: pcra,
      ticker_symbol: ticker,
      security_name: name,
      is_cash_equivalent: false,
      security_type: "mutual fund",
      institution_value: value,
    });
    const investment = (id: string, name: string, institution: string) => ({
      id,
      name,
      institution_name: institution,
      type: "investment",
      subtype: null,
      currency: "USD",
      current: null,
      available: null,
      balance_as_of: null,
    });
    const accounts = [
      investment(acct, "Acme Retirement Savings Plan", "Principal"),
      investment(pcra, "PCRA Trust", "Charles Schwab"),
    ];
    const holdings = [
      held("The 2055 Retirement Fund", "100000"),
      held("Self-Directed Brokerage Account", "51059.51"),
      fund("SWPPX", "Schwab S&P 500 Index Fd", "47463.39"),
      fund("SFREX", "Schwab Fundamental Gl Real Estate Idx Fd", "3401.89"),
    ];
    const found = workplaceFindings(
      [{ account_id: acct, facts: facts() }],
      holdings,
      catalog,
      "2026-11-12",
      accounts,
    );
    const window = found.items.find((m) => m.detector === "brokerage_window");
    // The S&P 500 fund is copied by the plan's large-cap index fund: 47463.39 x (0.02% - 0.01%).
    // The plan has no real-estate fund, so the global real-estate fund stays in the window.
    expect(window).toMatchObject({
      key: `brokerage_window:${acct}`,
      category: "securities",
      annual_cost: "4.75",
      account_ids: [acct, pcra],
      action: "Move Acme 401(k)'s brokerage window back into the plan's index funds",
      inputs: {
        plan_name: "Acme 401(k)",
        window_fund: "Self-Directed Brokerage Account",
        window_account: { id: pcra, name: "PCRA Trust", institution: "Charles Schwab" },
        paychecks_too: true,
        funds: [{ name: "Schwab S&P 500 Index Fund", ticker: "SWPPX" }],
        stays: [
          {
            name: "Schwab Fundamental Global Real Estate Index Fund",
            ticker: "SFREX",
            missing: ["US real-estate stocks", "international real-estate stocks"],
          },
        ],
        copy: [
          {
            label: "US large-cap stocks",
            holds: "100",
            fund: "U.S. Large Cap Equity Index Fund",
            percent: 100,
          },
        ],
        into: [{ fund: "U.S. Large Cap Equity Index Fund", percent: 100 }],
      },
    });
    const steps = stepsFor(
      { ...(window as object), detector: "brokerage_window", accountIds: [acct, pcra] } as never,
      () => null,
    );
    expect(steps.map((x) => x.text)).toEqual([
      "In PCRA Trust at Charles Schwab, Acme 401(k)'s brokerage window, sell Schwab S&P 500 Index Fund and keep Schwab Fundamental Global Real Estate Index Fund",
      "Once the sale settles, move that cash back into Acme 401(k) and put it into 100% U.S. Large Cap Equity Index Fund",
      "Stop sending paychecks to Self-Directed Brokerage Account: give its share to the funds on the new-money card",
      "Check that only Schwab Fundamental Global Real Estate Index Fund is left in PCRA Trust at Charles Schwab and Acme 401(k) holds the rest",
    ]);
    expect(steps.every((x) => x.by === "agent")).toBe(true);
    expect(
      carriedBy({
        category: "securities",
        actions: [],
        steps,
        finding: { detector: "brokerage_window" },
      }),
    ).toBe("agent");

    // The owner can choose to sell what the plan can't copy: its money goes in the same split as
    // the rest. Now 47463.39 x 0.02% + 3401.89 x 0.39% = 22.76, against 50865.28 x 0.01% = 5.09.
    const chosen = workplaceFindings(
      [{ account_id: acct, facts: facts({}, { window_also_sell: ["SFREX"] }) }],
      holdings,
      catalog,
      "2026-11-12",
      accounts,
    );
    const all = chosen.items.find((m) => m.detector === "brokerage_window");
    expect(all).toMatchObject({
      annual_cost: "17.67",
      inputs: {
        stays: [],
        spread: [{ ticker: "SFREX" }],
        funds: [{ ticker: "SWPPX" }, { ticker: "SFREX" }],
        into: [{ fund: "U.S. Large Cap Equity Index Fund", percent: 100 }],
        copy: [
          { label: "US large-cap stocks", holds: "93.31", percent: 100 },
          { label: "US real-estate stocks", holds: "3.83", percent: 0, spread: true },
          { label: "International real-estate stocks", holds: "2.86", percent: 0, spread: true },
        ],
      },
    });
    expect(all?.summary).toMatch(/is sold too, by your choice/);
    const sellAll = stepsFor(
      { ...(all as object), detector: "brokerage_window", accountIds: [acct, pcra] } as never,
      () => null,
    );
    expect(sellAll[0]?.text).toBe(
      "In PCRA Trust at Charles Schwab, Acme 401(k)'s brokerage window, sell everything (Schwab S&P 500 Index Fund and Schwab Fundamental Global Real Estate Index Fund)",
    );
    // Selling and buying back waits for calm markets (decision 0008).
    expect(all?.inputs).toMatchObject({ wait_for: "calm_markets", matches: null });

    // When the owner's paychecks match a plan fund, the window's money goes into the same copy:
    // 46/12/31/11 like The 2055 Retirement Fund, a change of mix by the owner's choice. The copy
    // costs 50865.28 x 0.0205% = 10.43 a year against 22.76.
    const mirrored = workplaceFindings(
      [
        {
          account_id: acct,
          facts: facts(
            {},
            { window_also_sell: ["SFREX"], paychecks_mirror: "The 2055 Retirement Fund" },
          ),
        },
      ],
      holdings,
      catalog,
      "2026-11-12",
      accounts,
    );
    const mirror = mirrored.items.find((m) => m.detector === "brokerage_window");
    expect(mirror).toMatchObject({
      annual_cost: "12.33",
      inputs: {
        matches: "The 2055 Retirement Fund",
        wait_for: "calm_markets",
        alternative_expense_ratio: "0.0205",
        into: [
          { fund: "U.S. Large Cap Equity Index Fund", percent: 46 },
          { fund: "International Equity Index Fund", percent: 31 },
          { fund: "U.S. Small/Mid Cap Equity Index Fund", percent: 12 },
          { fund: "Diversified Bond Index Fund", percent: 11 },
        ],
        copy: [
          { label: "US large-cap stocks", holds: "93.31", percent: 46 },
          { sleeve: "intl_stocks", holds: "0", percent: 31 },
          { sleeve: "us_stocks.small_mid", holds: "0", percent: 12 },
          { sleeve: "bonds", holds: "0", percent: 11 },
          { label: "US real-estate stocks", holds: "3.83", percent: 0, spread: true },
          { label: "International real-estate stocks", holds: "2.86", percent: 0, spread: true },
        ],
      },
    });
    expect(mirror?.summary).toMatch(
      /Its funds hold 93\.31% US large-cap stocks, 3\.83% US real-estate stocks and 2\.86% international real-estate stocks for 0\.0447% a year\. By your choice the money goes into a copy of The 2055 Retirement Fund, like your paychecks: 46% U\.S\. Large Cap/,
    );
    const mirrorSteps = stepsFor(
      { ...(mirror as object), detector: "brokerage_window", accountIds: [acct, pcra] } as never,
      () => null,
    );
    expect(mirrorSteps[1]?.text).toBe(
      "Once the sale settles, move all the cash back into Acme 401(k) and put it into 46% U.S. Large Cap Equity Index Fund, 31% International Equity Index Fund, 12% U.S. Small/Mid Cap Equity Index Fund, 11% Diversified Bond Index Fund, a copy of The 2055 Retirement Fund",
    );
    expect(found.window_tickers[acct]).toEqual(["SWPPX", "SFREX"]);

    // The move counts as done once the funds it sold have left the window, not when it can't
    // be made any more.
    const row = {
      detector: "brokerage_window",
      inputs: (window as { inputs: object }).inputs,
      accountIds: [acct, pcra],
      productId: null,
    };
    const base = { card_ids: [], cash_institutions: [] };
    expect(
      actedOn(row, { ...base, workplace_window_tickers: { [acct]: ["SWPPX", "SFREX"] } }),
    ).toBe(false);
    expect(actedOn(row, { ...base, workplace_window_tickers: { [acct]: ["SFREX"] } })).toBe(true);

    // A window holding only what the plan can't copy has nothing to move.
    const left = workplaceFindings(
      [{ account_id: acct, facts: facts() }],
      [...holdings.slice(0, 2), holdings[3] as SnapshotHolding],
      catalog,
      "2026-11-12",
      accounts,
    );
    expect(left.items.some((m) => m.detector === "brokerage_window")).toBe(false);
    expect(left.undecided).toEqual([]);

    // A fund the catalog doesn't know leaves the move undecided.
    const unknown = workplaceFindings(
      [{ account_id: acct, facts: facts() }],
      [...holdings, fund("ZZZZX", "Some Fund", "100")],
      catalog,
      "2026-11-12",
      accounts,
    );
    expect(unknown.items.some((m) => m.detector === "brokerage_window")).toBe(false);
    expect(unknown.undecided).toEqual([`brokerage_window:${acct}`]);

    // An empty window, or one not linked, is nothing to move.
    const empty = workplaceFindings(
      [{ account_id: acct, facts: facts() }],
      holdings.slice(0, 2),
      catalog,
      "2026-11-12",
      accounts,
    );
    expect(empty.items.some((m) => m.detector === "brokerage_window")).toBe(false);
  });

  it("rounds a split to whole steps that add up to 100", () => {
    expect(roundedPercents([new Big("0.54"), new Big("0.36"), new Big("0.10")])).toEqual([
      55, 35, 10,
    ]);
    expect(roundedPercents([new Big(1), new Big(1), new Big(1)], 1)).toEqual([34, 33, 33]);
  });
});

describe("new money with a workplace plan", () => {
  it("caps one bucket's share and gives the rest by target", () => {
    const targets = [
      { key: "us_stocks", target: new Big("0.55") },
      { key: "intl_stocks", target: new Big("0.30") },
      { key: "bonds_and_cash", target: new Big("0.10") },
      { key: "commodities", target: new Big("0.05") },
    ];
    const capped = capShares([{ key: "intl_stocks", share: new Big(1) }], targets, new Big("0.6"));
    expect(capped.map((r) => [r.key, r.share.toFixed(4)])).toEqual([
      ["us_stocks", "0.3143"],
      ["intl_stocks", "0.6000"],
      ["bonds_and_cash", "0.0571"],
      ["commodities", "0.0286"],
    ]);
  });

  it("adds the plan's paycheck split, in its cheapest fund per bucket", () => {
    const allocation = {
      state: "ready",
      as_of: "2026-11-12",
      buckets: [
        { key: "us_stocks", label: "US stocks", target: "55", classes: ["us_stocks"] },
        {
          key: "intl_stocks",
          label: "International stocks",
          target: "30",
          classes: ["intl_stocks"],
        },
        {
          key: "bonds_and_cash",
          label: "Bonds and cash",
          target: "10",
          classes: ["bonds", "cash"],
        },
        { key: "commodities", label: "Metals", target: "5", classes: ["commodities"] },
      ],
      new_money: {
        basis: "catch_up",
        catch_up: "20",
        split: [
          { bucket: "intl_stocks", percent: "60", buy: { ticker: "VXUS", name: null, held: true } },
          { bucket: "us_stocks", percent: "31", buy: { ticker: "VTI", name: null, held: true } },
          {
            bucket: "bonds_and_cash",
            percent: "6",
            buy: { ticker: "BND", name: null, held: false },
          },
          { bucket: "commodities", percent: "3", buy: { ticker: "GLDM", name: null, held: false } },
        ],
      },
    } as unknown as AllocationResult;
    const draft = newMoneyDraft(allocation, [
      { account_id: "33333333-3333-4333-8333-333333333333", facts: facts() },
    ]);
    // No metals fund in the plan: the other three scale up to 100.
    expect(draft?.steps.at(-2)).toEqual({
      text: "In Acme 401(k), invest each paycheck 62% International Equity Index Fund, 32% U.S. Large Cap Equity Index Fund, 6% Diversified Bond Index Fund",
      by: "agent",
      needs_you: "Sign-in",
    });
    expect(draft?.steps.at(-1)?.text).toBe("Leave everything you already hold as it is");

    // With the policy's 60% cap, the metals share goes to US stocks and bonds by target instead.
    const capped = newMoneyDraft(
      {
        ...allocation,
        new_money: { ...(allocation as { new_money: object }).new_money, max_share: "0.6" },
      } as AllocationResult,
      [{ account_id: "33333333-3333-4333-8333-333333333333", facts: facts() }],
    );
    expect(capped?.steps.at(-2)?.text).toBe(
      "In Acme 401(k), invest each paycheck 60% International Equity Index Fund, 34% U.S. Large Cap Equity Index Fund, 6% Diversified Bond Index Fund",
    );

    // Paychecks set to match a fund copy its recorded mix instead of steering toward the target.
    const plan = "33333333-3333-4333-8333-333333333333";
    const mirrored = facts({}, { paychecks_mirror: "The 2055 Retirement Fund" });
    const copy =
      "In Acme 401(k), invest each paycheck 46% U.S. Large Cap Equity Index Fund, 31% International Equity Index Fund, 12% U.S. Small/Mid Cap Equity Index Fund, 11% Diversified Bond Index Fund, a copy of The 2055 Retirement Fund";
    expect(
      newMoneyDraft(allocation, [{ account_id: plan, facts: mirrored }])?.steps.at(-2)?.text,
    ).toBe(copy);
    // Once the election matches, there is nothing to change.
    const elected = facts(
      {},
      {
        paychecks_mirror: "The 2055 Retirement Fund",
        paycheck_investments: [
          { fund: "U.S. Large Cap Equity Index Fund", percent: "46" },
          { fund: "International Equity Index Fund", percent: "31" },
          { fund: "U.S. Small/Mid Cap Equity Index Fund", percent: "12" },
          { fund: "Diversified Bond Index Fund", percent: "11" },
        ],
      },
    );
    const steps = newMoneyDraft(allocation, [{ account_id: plan, facts: elected }])?.steps ?? [];
    expect(steps.some((s) => s.text.startsWith("In Acme 401(k)"))).toBe(false);
    // The brokerage window's paycheck share goes to the same copy.
    expect(paycheckMirror(mirrored)).toMatchObject({ fund: "The 2055 Retirement Fund" });
    const window = stepsFor(
      {
        detector: "brokerage_window",
        accountIds: [plan],
        inputs: {
          plan_name: "Acme 401(k)",
          window_fund: "Self-Directed Brokerage Account",
          into: [],
          paychecks_too: true,
          paychecks_mirror: paycheckMirror(mirrored),
        },
      } as never,
      () => null,
    );
    expect(window.map((s) => s.text)).toContain(
      "Stop sending paychecks to Self-Directed Brokerage Account: invest each whole paycheck 46% U.S. Large Cap Equity Index Fund, 31% International Equity Index Fund, 12% U.S. Small/Mid Cap Equity Index Fund, 11% Diversified Bond Index Fund, a copy of The 2055 Retirement Fund",
    );
  });
});

describe("recorded plans", () => {
  const owner = connect(inject("databaseUrl"));
  afterAll(async () => {
    await owner.close();
  });

  it("are stored per account, readable but not writable by agents", async () => {
    // Its own user, so other test files counting the owner's accounts don't see this one.
    const [user] = await owner.db
      .insert(appUser)
      .values({ displayName: "Workplace test" })
      .returning({ id: appUser.id });
    if (!user) throw new Error("no user");
    const userId = user.id;
    const [it0] = await owner.db
      .insert(item)
      .values({ userId, source: "plaid", plaidItemId: "wp-item", institutionName: "Plan Co" })
      .returning();
    if (!it0) throw new Error("no item");
    const [plan] = await owner.db
      .insert(account)
      .values({ userId, itemId: it0.id, name: "401(k)", type: "investment", subtype: "401k" })
      .returning();
    if (!plan) throw new Error("no account");
    const agentDb = connectAgent(inject("databaseUrl"), userId);
    try {
      await setWorkplacePlan(owner.db, userId, plan.id, JSON.parse(JSON.stringify(facts())));
      await setWorkplacePlan(
        owner.db,
        userId,
        plan.id,
        JSON.parse(JSON.stringify(facts({ ytd_employee: "17000" }))),
      );
      const read = await readWorkplacePlans(agentDb);
      expect(read).toHaveLength(1);
      expect(read[0]).toMatchObject({
        account_id: plan.id,
        facts: { contributions: { ytd_employee: "17000" } },
      });
      await expect(agentDb.query("update workplace_plan set as_of = '2026-01-01'")).rejects.toThrow(
        /read-only transaction|permission denied/,
      );
      await expect(
        setWorkplacePlan(owner.db, userId, "44444444-4444-4444-8444-444444444444", facts()),
      ).rejects.toThrow(/no account/);
      expect(() =>
        parseWorkplaceFacts({ ...facts(), paycheck_investments: [{ fund: "x", percent: "50" }] }),
      ).toThrow(/add up to 100/);
    } finally {
      await owner.db.delete(workplacePlan).where(eq(workplacePlan.accountId, plan.id));
      await owner.db.delete(account).where(eq(account.id, plan.id));
      await owner.db.delete(item).where(eq(item.id, it0.id));
      await owner.db.delete(appUser).where(eq(appUser.id, userId));
      await agentDb.end();
    }
  });
});

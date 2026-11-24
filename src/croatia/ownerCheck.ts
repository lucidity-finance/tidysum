import Big from "big.js";
import { z } from "zod";
import { type DividendFinding, dividendFindings } from "./investing.js";
import { type CroatiaRules, rulesFor } from "./rules.js";

// Decision 0014: for someone in Croatia who runs an obrt (dohodaš) and owns a d.o.o., find the
// money lost to how the work is billed and how profit reaches the owner, and price it in euros a
// year (decision 0003). Pure arithmetic on facts the owner gives (from their books and ePorezna
// receipts), so it reads no accounts and moves nothing. Tax facts, not investment advice; every
// result tells the owner to confirm with their accountant before changing how they are paid.

const decimal = z.string().regex(/^\d{1,12}(\.\d{1,4})?$/, "must be a decimal string like 1250.50");
const rate = z.string().regex(/^0(\.\d{1,6})?$|^1(\.0{1,6})?$/, "must be a fraction like 0.23");

export const CroatiaOwnerShape = {
  tax_year: z.number().int().min(2024).max(2100),
  as_of: z.iso.date(),
  /** The owner's city income tax rates, when not Zagreb's. */
  city_rates: z.object({ city: z.string().min(1).max(60), lower: rate, higher: rate }).optional(),
  /** Overrides for the contribution bases, when the year's rules are newer than Tidysum's. */
  bases: z
    .object({ min_base_monthly: decimal.optional(), max_base_monthly: decimal.optional() })
    .optional(),
  obrt: z
    .object({
      name: z.string().min(1).max(80).optional(),
      /** A year's receipts minus expenses, before the owner's own contributions. */
      profit: decimal,
    })
    .optional(),
  company: z
    .object({
      name: z.string().min(1).max(80).optional(),
      /** A year's revenue: sets the profit tax rate. */
      revenue: decimal,
      /** A year's profit before any pay to the owner. */
      profit: decimal,
      /** Gross yearly salary the company pays the owner now (bruto 1). */
      owner_salary: decimal.default("0"),
      /** Cash on the company's accounts, and the yearly rate it earns there (0.005 for 0.5%). */
      cash: decimal.optional(),
      cash_rate: rate.optional(),
      /** Cash the company needs at hand (taxes, a few months' costs); the rest could earn more. */
      cash_buffer: decimal.optional(),
    })
    .optional(),
  /** A yearly rate cash can earn at low risk (a money market fund near €STR), 0.019 for 1.9%. */
  benchmark_rate: rate.optional(),
  /** What the owner paid into a III. stup fund this tax year. */
  pillar3_contributed: decimal.optional(),
  /**
   * Shares or fund units held personally: with `acquired` and `cost` for the two-year capital
   * gains exemption, with `domicile` and `dividend_yield` for what their dividends lose to tax.
   */
  lots: z
    .array(
      z
        .object({
          name: z.string().min(1).max(80),
          value: decimal,
          acquired: z.iso.date().optional(),
          cost: decimal.optional(),
          domicile: z.enum(["US", "IE", "LU", "HR", "other"]).optional(),
          kind: z.enum(["stock", "fund"]).optional(),
          distributing: z.boolean().optional(),
          dividend_yield: rate.optional(),
          us_share: rate.optional(),
        })
        .strict(),
    )
    .max(200)
    .optional(),
  /** US dollars per euro, for the US estate tax limit. */
  usd_per_eur: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,6})?$/)
    .optional(),
};

export const CroatiaOwnerSchema = z.object(CroatiaOwnerShape).strict();
export type CroatiaOwnerFacts = z.infer<typeof CroatiaOwnerSchema>;

export function parseCroatiaOwner(json: unknown): CroatiaOwnerFacts {
  const r = CroatiaOwnerSchema.safeParse(json);
  if (!r.success) {
    throw new Error(
      `invalid Croatian owner facts: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    );
  }
  return r.data;
}

export interface CroatiaFinding {
  key: string;
  kind: "billing" | "owner_pay" | "company_cash" | "pillar3" | DividendFinding["kind"];
  summary: string;
  /** Euros a year more in the owner's hands after every tax and contribution. */
  annual_cost: string;
  currency: "EUR";
  action: string;
  inputs: Record<string, string>;
}

export interface Scenario {
  /** Obrt profit billed through the company instead. */
  shifted_to_company: string;
  owner_salary: string;
  obrt_contributions: string;
  /** Pension contributions (I and II) paid for the owner: pension rights, not only cost. */
  pension_contributions: string;
  income_tax: string;
  profit_tax: string;
  dividend: string;
  dividend_tax: string;
  /** What reaches the owner a year after every tax and contribution. */
  owner_net: string;
}

export interface CroatiaOwnerReport {
  tax_year: number;
  as_of: string;
  currency: "EUR";
  rules: { year: number; checked_on: string; city: string; sources: CroatiaRules["sources"] };
  current: Scenario | null;
  best: Scenario | null;
  findings: CroatiaFinding[];
  holding_periods: HoldingPeriod[];
  notes: string[];
  warnings: string[];
  disclaimer: string;
}

export interface HoldingPeriod {
  name: string;
  gain: string;
  tax_if_sold_now: string;
  tax_free_from: string;
  days_left: number;
}

export const DISCLAIMER =
  "Arithmetic on the facts given and the public rules listed, not tax or legal advice. Moving " +
  "work between an obrt and a d.o.o., or changing how the owner is paid, has effects this does " +
  "not price (pension rights, sick pay, who insures the owner, how work is contracted). Confirm " +
  "with an accountant (računovođa) before acting.";

const ZERO = new Big(0);
const max0 = (b: Big) => (b.lt(0) ? ZERO : b);
const minB = (a: Big, b: Big) => (a.lt(b) ? a : b);
const eur = (b: Big) => b.round(2, Big.roundHalfUp).toFixed(2);
const pct = (s: string | Big) => `${new Big(s).times(100).round(2).toFixed()}%`;
const fmt = (b: Big) =>
  `EUR ${b
    .round(0, Big.roundHalfUp)
    .toFixed(0)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

interface Rates {
  r: CroatiaRules;
  lower: Big;
  higher: Big;
  bracket: Big;
  allowance: Big;
  minBase: Big;
  maxBase: Big;
}

/** Yearly income tax on employment and obrt income together, after the personal allowance. */
export function incomeTax(income: Big, x: Rates): Big {
  const taxable = max0(income.minus(x.allowance));
  const low = minB(taxable, x.bracket);
  return low.times(x.lower).plus(max0(taxable.minus(x.bracket)).times(x.higher));
}

/**
 * An obrt dohodaš year in steady state: its contribution base is last year's income / 12, kept
 * between the minimum and maximum base, and contributions are deducted from that income.
 */
export function obrtYear(profit: Big, x: Rates): { contributions: Big; income: Big; pension: Big } {
  const rate = new Big(x.r.self_employed.pension).plus(x.r.self_employed.health);
  const floor = x.minBase.times(12);
  const cap = x.maxBase.times(12);
  let base = profit.div(rate.plus(1));
  if (base.lt(floor)) base = floor;
  if (base.gt(cap)) base = cap;
  const contributions = base.times(rate);
  return {
    contributions,
    income: profit.minus(contributions),
    pension: base.times(x.r.self_employed.pension),
  };
}

function scenario(f: CroatiaOwnerFacts, x: Rates, shift: Big, salary: Big): Scenario | null {
  const obrtProfit = new Big(f.obrt?.profit ?? 0).minus(shift);
  const obrt = f.obrt
    ? obrtYear(obrtProfit, x)
    : { contributions: ZERO, income: ZERO, pension: ZERO };
  const c = f.company;
  const revenue = new Big(c?.revenue ?? 0).plus(shift);
  const health = new Big(x.r.employee.health);
  const companyProfit = new Big(c?.profit ?? 0).plus(shift).minus(salary.times(health.plus(1)));
  if (companyProfit.lt(0) && salary.gt(0)) return null;
  const profitRate = revenue.gt(x.r.profit_tax.revenue_threshold)
    ? new Big(x.r.profit_tax.higher)
    : new Big(x.r.profit_tax.lower);
  const profitTax = max0(companyProfit).times(profitRate);
  const dividend = max0(companyProfit.minus(profitTax));
  const dividendTax = dividend.times(x.r.dividend_tax);
  const pensionRate = new Big(x.r.employee.pension_1).plus(x.r.employee.pension_2);
  const salaryPension = minB(salary, x.maxBase.times(12)).times(pensionRate);
  const tax = incomeTax(obrt.income.plus(salary).minus(salaryPension), x);
  const net = obrtProfit
    .minus(obrt.contributions)
    .plus(salary)
    .minus(salaryPension)
    .minus(tax)
    .plus(dividend)
    .minus(dividendTax);
  return {
    shifted_to_company: eur(shift),
    owner_salary: eur(salary),
    obrt_contributions: eur(obrt.contributions),
    pension_contributions: eur(obrt.pension.plus(salaryPension)),
    income_tax: eur(tax),
    profit_tax: eur(profitTax),
    dividend: eur(dividend),
    dividend_tax: eur(dividendTax),
    owner_net: eur(net),
  };
}

/** Steps from 0 to `top` inclusive, about `n` of them, never finer than `minStep`. */
function steps(top: Big, n: number, minStep: Big): Big[] {
  if (top.lte(0)) return [ZERO];
  let step = top.div(n);
  if (step.lt(minStep)) step = minStep;
  const out: Big[] = [];
  for (let v = ZERO; v.lt(top); v = v.plus(step)) out.push(v);
  out.push(top);
  return out;
}

const better = (a: Scenario | null, b: Scenario | null) =>
  b && (!a || new Big(b.owner_net).gt(a.owner_net)) ? b : a;

export interface CheckOptions {
  /**
   * The dividend findings are investment advice (decision 0002, principle 8): on for the owner
   * running the CLI on their own money, and over MCP only with `app_user.investing_enabled`.
   */
  investing: boolean;
}

export function croatiaOwnerCheck(
  facts: CroatiaOwnerFacts,
  options: CheckOptions = { investing: false },
): CroatiaOwnerReport {
  const warnings: string[] = [];
  const notes: string[] = [];
  const r = rulesFor(facts.tax_year, warnings);
  const city = facts.city_rates ?? r.city_rates;
  const x: Rates = {
    r,
    lower: new Big(city.lower),
    higher: new Big(city.higher),
    bracket: new Big(r.bracket_annual),
    allowance: new Big(r.personal_allowance_monthly).times(12),
    minBase: new Big(facts.bases?.min_base_monthly ?? r.self_employed.min_base_monthly),
    maxBase: new Big(facts.bases?.max_base_monthly ?? r.max_base_monthly),
  };
  const findings: CroatiaFinding[] = [];
  const salary0 = new Big(facts.company?.owner_salary ?? 0);

  let current: Scenario | null = null;
  let best: Scenario | null = null;
  if (facts.obrt || facts.company) {
    current = scenario(facts, x, ZERO, salary0);
    if (!current) {
      warnings.push(
        "The company's profit doesn't cover the owner's salary and its health contribution.",
      );
    }
    const obrtProfit = new Big(facts.obrt?.profit ?? 0);
    const shifts = facts.company && facts.obrt ? steps(obrtProfit, 100, new Big(100)) : [ZERO];
    const healthUp = new Big(r.employee.health).plus(1);
    const salaryTop = (s: Big) =>
      facts.company
        ? max0(new Big(facts.company.profit).plus(s)).div(healthUp).round(0, Big.roundDown)
        : ZERO;

    // Billing: the best share of obrt work to bill through the company, pay unchanged.
    if (current && facts.company && facts.obrt) {
      let bestShift: Scenario | null = current;
      for (const s of shifts) bestShift = better(bestShift, scenario(facts, x, s, salary0));
      const gain = new Big(bestShift?.owner_net ?? 0).minus(current.owner_net);
      if (bestShift && gain.gte(1)) {
        const pensionLost = new Big(current.pension_contributions).minus(
          bestShift.pension_contributions,
        );
        findings.push({
          key: "hr:billing",
          kind: "billing",
          summary:
            `Billing ${fmt(new Big(bestShift.shifted_to_company))} a year of ${facts.obrt.name ?? "the obrt"}'s work ` +
            `through ${facts.company.name ?? "the company"} instead would leave ${fmt(gain)} a year more after ` +
            `tax: obrt profit pays contributions on a base that follows income (${pct(
              new Big(r.self_employed.pension).plus(r.self_employed.health),
            )}) and income tax up to ${pct(x.higher)}, company profit ${pct(r.profit_tax.lower)} profit ` +
            `tax and ${pct(r.dividend_tax)} on the dividend.` +
            (pensionLost.gt(0)
              ? ` It also pays ${fmt(pensionLost)} a year less into the owner's pension.`
              : ""),
          annual_cost: eur(gain),
          currency: "EUR",
          action:
            "Talk to the accountant about invoicing new and renewed client contracts from the company, " +
            "keeping the obrt open at the minimum base if it is what insures the owner.",
          inputs: {
            obrt_profit: eur(obrtProfit),
            shifted: bestShift.shifted_to_company,
            owner_net_now: current.owner_net,
            owner_net_after: bestShift.owner_net,
            pension_contributions_forgone: eur(max0(pensionLost)),
          },
        });
      }
    }

    // Owner pay: the best salary from the company, billing unchanged.
    if (current && facts.company) {
      let bestPay: Scenario | null = current;
      for (const g of steps(salaryTop(ZERO), 200, new Big(1200))) {
        bestPay = better(bestPay, scenario(facts, x, ZERO, g));
      }
      const gain = new Big(bestPay?.owner_net ?? 0).minus(current.owner_net);
      if (bestPay && gain.gte(1)) {
        const to = new Big(bestPay.owner_salary);
        const name = facts.company.name ?? "the company";
        const pay = to.eq(0)
          ? `all as dividends`
          : `${fmt(to)} a year as gross salary and the rest as dividends`;
        findings.push({
          key: "hr:owner_pay",
          kind: "owner_pay",
          summary:
            `Taking ${name}'s profit ${pay}, instead of a ${fmt(salary0)} salary, would leave ` +
            `${fmt(gain)} a year more after tax.`,
          annual_cost: eur(gain),
          currency: "EUR",
          action:
            "Ask the accountant to set the owner's pay from the company to this mix from next month, " +
            "and to confirm who insures the owner.",
          inputs: {
            salary_now: eur(salary0),
            salary_best: bestPay.owner_salary,
            owner_net_now: current.owner_net,
            owner_net_after: bestPay.owner_net,
          },
        });
      }
    }

    // Both at once, for the notes: findings above are each alone and don't add up.
    if (current) {
      best = current;
      for (const s of shifts) {
        for (const g of steps(salaryTop(s), 60, new Big(1200)))
          best = better(best, scenario(facts, x, s, g));
      }
    }
    if (findings.length > 1 && best && current) {
      notes.push(
        `The billing and pay findings overlap; done together the best mix leaves ` +
          `${fmt(new Big(best.owner_net).minus(current.owner_net))} a year more (the best scenario).`,
      );
    }
    if (facts.company) {
      notes.push(
        "Profit kept in the company pays only profit tax; the dividend tax is due when it is paid " +
          "out, so profit the owner doesn't need yet can be invested by the company first.",
      );
    }
  }

  // Company cash earning less than a money market fund would.
  const c = facts.company;
  if (c?.cash) {
    const bench = facts.benchmark_rate;
    if (!bench) {
      warnings.push("No benchmark_rate, so the company's cash can't be priced.");
    } else {
      const idle = max0(new Big(c.cash).minus(c.cash_buffer ?? 0));
      const gap = new Big(bench).minus(c.cash_rate ?? 0);
      const profitRate = new Big(c.revenue).gt(r.profit_tax.revenue_threshold)
        ? r.profit_tax.higher
        : r.profit_tax.lower;
      const gain = idle.times(gap).times(new Big(1).minus(profitRate));
      if (gap.gt(0) && gain.gte(1)) {
        findings.push({
          key: "hr:company_cash",
          kind: "company_cash",
          summary:
            `${fmt(idle)} of ${c.name ?? "the company"}'s cash earns ${pct(c.cash_rate ?? "0")}; at ` +
            `${pct(bench)} it would earn ${fmt(gain)} a year more after profit tax.`,
          annual_cost: eur(gain),
          currency: "EUR",
          action:
            "Move cash above the buffer to a company savings or term deposit, or a euro money market " +
            "fund, that pays near the benchmark.",
          inputs: {
            cash: eur(new Big(c.cash)),
            buffer: eur(new Big(c.cash_buffer ?? 0)),
            cash_rate: c.cash_rate ?? "0",
            benchmark_rate: bench,
          },
        });
      }
    }
  }

  // III. stup: the state's 15% is free money up to the cap.
  if (facts.pillar3_contributed !== undefined) {
    const cap = new Big(r.pillar3.incentive_cap_contribution);
    const missing = max0(cap.minus(facts.pillar3_contributed));
    const gain = missing.times(r.pillar3.incentive_rate);
    if (gain.gte(1)) {
      findings.push({
        key: `hr:pillar3:${facts.tax_year}`,
        kind: "pillar3",
        summary:
          `Paying EUR ${eur(missing)} more into a III. stup fund by December 31 adds EUR ${eur(gain)} of ` +
          `state incentive (${pct(r.pillar3.incentive_rate)} of up to EUR ${eur(cap)} a year).`,
        annual_cost: eur(gain),
        currency: "EUR",
        action: `Pay EUR ${eur(missing)} into the owner's voluntary pension fund before the year ends.`,
        inputs: { contributed: facts.pillar3_contributed, cap: eur(cap) },
      });
    }
  }

  const lots = facts.lots ?? [];
  if (options.investing) {
    findings.push(...dividendFindings(lots, r, facts.usd_per_eur, warnings));
  } else if (lots.some((l) => l.domicile)) {
    warnings.push(
      "What the holdings' dividends lose to tax is investment advice, so it runs only with investing turned on.",
    );
  }
  findings.sort((a, b) => new Big(b.annual_cost).cmp(a.annual_cost));

  const holding_periods: HoldingPeriod[] = [];
  for (const lot of lots) {
    if (!lot.acquired || !lot.cost) continue;
    const gain = new Big(lot.value).minus(lot.cost);
    const free = new Date(`${lot.acquired}T00:00:00Z`);
    free.setUTCFullYear(free.getUTCFullYear() + r.capital_gains.exempt_after_years);
    free.setUTCDate(free.getUTCDate() + 1);
    const days = Math.ceil((free.getTime() - Date.parse(`${facts.as_of}T00:00:00Z`)) / 86_400_000);
    if (gain.lte(0) || days <= 0) continue;
    holding_periods.push({
      name: lot.name,
      gain: eur(gain),
      tax_if_sold_now: eur(gain.times(r.capital_gains.rate)),
      tax_free_from: free.toISOString().slice(0, 10),
      days_left: days,
    });
  }
  holding_periods.sort((a, b) => a.days_left - b.days_left);

  return {
    tax_year: facts.tax_year,
    as_of: facts.as_of,
    currency: "EUR",
    rules: { year: r.year, checked_on: r.checked_on, city: city.city, sources: r.sources },
    current,
    best,
    findings,
    holding_periods,
    notes,
    warnings,
    disclaimer: DISCLAIMER,
  };
}

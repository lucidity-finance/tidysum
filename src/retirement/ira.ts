import Big from "big.js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { iraYear } from "../db/schema.js";
import type { AgentDb } from "../mcp/agentDb.js";
import type { Misallocation } from "../misallocation/detect.js";
import type { SnapshotAccount, SnapshotHolding } from "../policy/snapshot.js";
import { findOverlaps, WINDOW } from "../portfolio/overlap.js";
import { bestMatch, type IraMatch, offerAt } from "./iraMatch.js";
import { electiveDeferralLimit, type FilingStatus, iraLimit } from "./limits.js";
import type { StoredPlan } from "./workplace.js";

// Roth IRA room (decision 0003). Each tax year allows one IRA contribution up to the limit, open
// from January 1 until the tax deadline the next April 15, and room not used by then is gone for
// good. Money in a Roth IRA grows tax-free; the same money in a taxable account pays tax on its
// growth every year. Above the Roth IRA income limit it goes in as a backdoor Roth: a
// nondeductible traditional IRA contribution converted to Roth, which is tax-free only while no
// traditional, SEP or SIMPLE IRA holds pre-tax money on December 31 of the conversion year (the
// pro-rata rule).
//
// Plaid shows IRA balances but not which tax year a contribution counts for, so what went in is
// recorded per tax year (`ira_year`): when the owner's agent finishes an IRA action, or by the
// owner. Investment advice, so it runs only for users with investing enabled.

const decimal = z.string().regex(/^\d{1,12}(\.\d{1,4})?$/, "must be a decimal string like 7500");

export const FILING_STATUSES = [
  "single",
  "head_of_household",
  "married_joint",
  "married_separate",
] as const satisfies readonly FilingStatus[];

export const IraYearSchema = z
  .object({
    tax_year: z.number().int().min(2000).max(2100),
    /** The day these were last true. */
    as_of: z.iso.date(),
    filing_status: z.enum(FILING_STATUSES).optional(),
    /** Expected modified AGI for the year, when known better than the workplace plan's pay says. */
    magi: decimal.optional(),
    /** Direct Roth IRA contributions for the tax year. */
    roth_contributed: decimal.default("0"),
    /** Traditional IRA contributions for the tax year (nondeductible, for a backdoor Roth). */
    traditional_contributed: decimal.default("0"),
    /** Traditional IRA money converted to Roth for it. */
    converted: decimal.default("0"),
    /** Paid memberships the owner already holds that raise a brokerage's IRA match ("Robinhood Gold"). */
    memberships: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
  })
  .strict();

export type IraYear = z.infer<typeof IraYearSchema>;

export function parseIraYear(json: unknown): IraYear {
  const r = IraYearSchema.safeParse(json);
  if (!r.success) {
    throw new Error(
      `invalid IRA year: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    );
  }
  return r.data;
}

type Writer = Pick<Db, "insert" | "select">;

/** Records a tax year's IRA facts for a user, replacing what was there. Owner side only. */
export async function setIraYear(db: Writer, userId: string, json: unknown): Promise<IraYear> {
  const facts = parseIraYear(json);
  await db
    .insert(iraYear)
    .values({ userId, taxYear: facts.tax_year, facts, asOf: facts.as_of })
    .onConflictDoUpdate({
      target: [iraYear.userId, iraYear.taxYear],
      set: { facts, asOf: facts.as_of, updatedAt: new Date() },
    });
  return facts;
}

/** Adds what an IRA action put in to its tax year's record. Owner side only. */
export async function addToIraYear(
  db: Writer,
  userId: string,
  year: number,
  add: { roth?: string; traditional?: string; converted?: string },
  asOf: string,
): Promise<IraYear> {
  const [row] = await db
    .select({ facts: iraYear.facts })
    .from(iraYear)
    .where(and(eq(iraYear.userId, userId), eq(iraYear.taxYear, year)));
  const was = row ? parseIraYear(row.facts) : parseIraYear({ tax_year: year, as_of: asOf });
  const plus = (a: string, b?: string) => new Big(a).plus(b ?? 0).toFixed();
  return setIraYear(db, userId, {
    ...was,
    as_of: asOf,
    roth_contributed: plus(was.roth_contributed, add.roth),
    traditional_contributed: plus(was.traditional_contributed, add.traditional),
    converted: plus(was.converted, add.converted),
  });
}

/** The agent's own user's IRA years, through row-level security; unreadable ones become warnings. */
export async function readIraYears(
  db: AgentDb,
  warnings: string[] = [],
): Promise<Map<number, IraYear>> {
  const { rows } = await db.query<{ tax_year: number; facts: unknown }>(
    "select tax_year, facts from ira_year order by tax_year",
  );
  const out = new Map<number, IraYear>();
  for (const r of rows) {
    const parsed = IraYearSchema.safeParse(r.facts);
    if (parsed.success) out.set(r.tax_year, parsed.data);
    else
      warnings.push(
        `The recorded IRA contributions for ${r.tax_year} no longer read; record them again.`,
      );
  }
  return out;
}

// Pricing ---------------------------------------------------------------------------------------

/**
 * Long-run yearly return assumed for money in the Roth: a stock-heavy portfolio's common planning
 * figure. The finding's cost is the tax this growth would pay in a taxable account.
 */
export const EXPECTED_RETURN = "0.07";

/** Ordinary income tax rate assumed for a conversion's taxable part when no plan records one. */
const ASSUMED_ORDINARY_RATE = new Big("0.24");

/** "0.03" as "3%". */
const pctOf = (f: string) => `${new Big(f).times(100).toFixed()}%`;

/** Federal long-term capital gains rate for most incomes; the 0% and 20% brackets aren't modeled. */
const GAINS_RATE = new Big("0.15");
/** Net investment income tax, on modified AGI above a threshold that isn't indexed to inflation. */
const NIIT_RATE = new Big("0.038");
const NIIT_FROM: Record<FilingStatus, string> = {
  single: "200000",
  head_of_household: "200000",
  married_joint: "250000",
  married_separate: "125000",
};

/** Federal tax on investment growth in a taxable account. State tax isn't counted. */
export function gainsTaxRate(magi: Big | null, filing: FilingStatus): Big {
  return magi?.gt(NIIT_FROM[filing]) ? GAINS_RATE.plus(NIIT_RATE) : GAINS_RATE;
}

/**
 * Modified AGI from a workplace plan: base pay and bonus, less the pre-tax 401(k) contributions
 * they make (up to the year's limit). Other income isn't seen, so this can only be low.
 */
export function magiFromPlans(plans: StoredPlan[], year: number): Big | null {
  if (plans.length === 0) return null;
  const limit = electiveDeferralLimit(year)?.value;
  let total = new Big(0);
  for (const { facts: f } of plans) {
    const salary = new Big(f.pay.salary);
    const bonus = new Big(f.pay.bonus ?? 0);
    const c = f.contributions;
    let pretax = salary
      .times(c.base.pretax)
      .div(100)
      .plus(bonus.times(c.bonus?.pretax ?? c.base.pretax).div(100));
    if (limit && pretax.gt(limit)) pretax = limit;
    total = total.plus(salary).plus(bonus).minus(pretax);
  }
  return total;
}

// Detection -------------------------------------------------------------------------------------

/** Plaid subtypes of IRAs that hold pre-tax money: what the pro-rata rule counts. */
const PRETAX_IRA = new Set(["ira", "sep ira", "simple ira", "sarsep"]);

const label = (a: SnapshotAccount) => [a.name, a.official_name ?? ""].join(" ");
const balance = (a: SnapshotAccount) => new Big(a.current ?? 0);
const money = (b: Big) => b.toFixed(2);
const whole = (b: Big) =>
  `$${b
    .round(0)
    .toFixed(0)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
const byBalance = (a: SnapshotAccount, b: SnapshotAccount) => balance(b).cmp(balance(a));

export interface AccountRef {
  id: string;
  name: string;
  institution: string | null;
}
const ref = (a: SnapshotAccount | undefined): AccountRef | null =>
  a ? { id: a.id, name: a.name, institution: a.institution_name ?? null } : null;

export interface RothIraInputs {
  kind: "contribute" | "convert";
  /** backdoor: through a traditional IRA. direct: straight into the Roth IRA. */
  route: "backdoor" | "direct";
  tax_year: number;
  /** What to put in (contribute) or convert (convert). */
  amount: string;
  limit: string;
  limit_official: boolean;
  /** Recorded for the tax year so far, all kinds together. */
  recorded_total: string;
  /** Whether anything was recorded for the year: if not, what went in already is unknown. */
  recorded: boolean;
  deadline: string;
  /** December 31 of the year a conversion made now lands in: no pre-tax IRA money then. */
  year_end: string;
  magi: string | null;
  magi_basis: "recorded" | "workplace_plan" | null;
  filing_status: FilingStatus;
  filing_status_assumed: boolean;
  expected_return: string;
  gains_tax_rate: string;
  roth_account: AccountRef | null;
  traditional_account: AccountRef | null;
  from_account: AccountRef | null;
  /** Pre-tax IRA money that would make a conversion partly taxable, and where it sits. */
  pretax_ira_balance: string;
  pretax_accounts: (AccountRef & { balance: string })[];
  /** The workplace plan to roll pre-tax IRA money into first, when there is some. */
  rollover_into: string | null;
  /** The brokerage's match on the contribution, at its better rate, when it has one. */
  match: IraMatch | null;
  /** Ordinary tax rate a backdoor conversion's match is taxed at, and whether it was assumed. */
  conversion_tax_rate: string;
  conversion_tax_rate_assumed: boolean;
}

export interface RothIraDetection {
  items: Misallocation[];
  warnings: string[];
  /** Each tax year's recorded total, to tell a contribution made from one gone quiet. */
  recorded: Record<string, string>;
}

const recordedTotal = (r: IraYear | undefined) =>
  r ? new Big(r.roth_contributed).plus(r.traditional_contributed).plus(r.converted) : new Big(0);

/** Tax years still open for contributions on `today`: this one, and last one until April 15. */
export function openTaxYears(today: string): number[] {
  const year = Number(today.slice(0, 4));
  return today <= `${year}-04-15` ? [year - 1, year] : [year];
}

export function rothIraFindings(p: {
  today: string;
  accounts: SnapshotAccount[];
  holdings: SnapshotHolding[];
  plans: StoredPlan[];
  years: Map<number, IraYear>;
}): RothIraDetection {
  const out: RothIraDetection = { items: [], warnings: [], recorded: {} };
  for (const [year, r] of p.years) out.recorded[String(year)] = recordedTotal(r).toFixed();

  // A 401(k)'s brokerage window can come through as an "ira" account; it isn't one.
  const windows = new Set(findOverlaps(p.accounts, p.holdings).map((o) => o.same_as_account_id));
  const planAccounts = new Set(p.plans.map((x) => x.account_id));
  const investment = p.accounts.filter(
    (a) =>
      a.type === "investment" &&
      !windows.has(a.id) &&
      !planAccounts.has(a.id) &&
      !WINDOW.test(label(a)),
  );
  const roth = investment.filter((a) => a.subtype === "roth").sort(byBalance)[0];
  const pretax = investment.filter((a) => PRETAX_IRA.has(a.subtype ?? ""));
  const traditional =
    pretax.find((a) => a.subtype === "ira" && a.institution_name === roth?.institution_name) ??
    pretax.find((a) => a.subtype === "ira");
  const checking = p.accounts
    .filter((a) => a.type === "depository" && a.subtype === "checking")
    .sort(byBalance)[0];
  const pretaxBalance = pretax.reduce(
    (s, a) => s.plus(balance(a).gt(0) ? balance(a) : 0),
    new Big(0),
  );
  const thisYear = Number(p.today.slice(0, 4));

  for (const year of openTaxYears(p.today)) {
    const limit = iraLimit(year);
    if (!limit) {
      out.warnings.push(`The ${year} IRA limit isn't known yet, so Roth IRA room isn't checked.`);
      continue;
    }
    const rec = p.years.get(year);
    const contributed = rec
      ? new Big(rec.roth_contributed).plus(rec.traditional_contributed)
      : new Big(0);
    const unconverted = rec
      ? new Big(rec.traditional_contributed).minus(rec.converted)
      : new Big(0);
    const filing = rec?.filing_status ?? "single";
    const magi = rec?.magi ? new Big(rec.magi) : magiFromPlans(p.plans, year);
    const magiBasis = rec?.magi ? "recorded" : magi ? "workplace_plan" : null;
    // Unknown income: the backdoor works at any income, so it's the safe way in.
    const route = magi?.lt(limit.roth_phase_out[filing].from) ? "direct" : "backdoor";
    const room = limit.value.minus(contributed);
    // Money already on its way through the traditional IRA isn't a pro-rata problem.
    const inFlight = unconverted.gt(0) ? unconverted : new Big(0);
    const pretaxLeft = pretaxBalance.minus(inFlight);

    let kind: RothIraInputs["kind"];
    let amount: Big;
    if (room.gte(1)) {
      kind = "contribute";
      amount = room;
    } else if (route === "backdoor" && unconverted.gte(1)) {
      kind = "convert";
      amount = unconverted;
    } else continue;

    const rollover = route === "backdoor" && pretaxLeft.gte(1);
    const plan = p.plans[0]?.facts.plan_name ?? null;
    if (rollover && !plan) {
      out.warnings.push(
        `A ${year} backdoor Roth would be partly taxed: about ${whole(pretaxLeft)} of pre-tax money sits in a traditional, SEP or SIMPLE IRA. Moving it into a workplace plan first avoids that; none is recorded.`,
      );
      continue;
    }

    const rate = gainsTaxRate(magi, filing);
    // The match is paid where the contribution lands; in a backdoor Roth it's converted with the
    // contribution and taxed as earnings at the ordinary rate.
    const planRate = p.plans
      .map((x) => new Big(x.facts.marginal_tax_rate))
      .reduce<Big | null>((a, b) => (a?.gte(b) ? a : b), null);
    const conversionRate = route === "backdoor" ? (planRate ?? ASSUMED_ORDINARY_RATE) : new Big(0);
    const lands = route === "backdoor" ? traditional : roth;
    const match =
      kind === "contribute"
        ? bestMatch(offerAt(lands?.institution_name), amount, conversionRate, rec?.memberships)
        : null;
    const cost = amount
      .times(EXPECTED_RETURN)
      .times(rate)
      .plus(match ? match.net : 0);
    const projected = limit.official ? "" : " (expected; the IRS hasn't announced it yet)";
    const deadline = `${year + 1}-04-15`;
    const how =
      route === "direct"
        ? ""
        : magi
          ? " Your income is over the direct Roth limit, so it goes in as a backdoor Roth."
          : " A backdoor Roth gets it in at any income.";
    const matched = match
      ? ` ${match.provider} adds a ${pctOf(match.rate)} match${match.membership ? ` with ${match.membership}` : ""} if the money stays there ${match.hold_years} years.`
      : "";
    const inputs: RothIraInputs = {
      kind,
      route,
      tax_year: year,
      amount: amount.toFixed(),
      limit: limit.amount,
      limit_official: limit.official,
      recorded_total: recordedTotal(rec).toFixed(),
      recorded: !!rec,
      deadline,
      year_end: `${thisYear}-12-31`,
      magi: magi ? magi.toFixed(0) : null,
      magi_basis: magiBasis,
      filing_status: filing,
      filing_status_assumed: !rec?.filing_status,
      expected_return: EXPECTED_RETURN,
      gains_tax_rate: rate.toFixed(),
      roth_account: ref(roth),
      traditional_account: route === "backdoor" ? ref(traditional) : null,
      from_account: ref(checking),
      pretax_ira_balance: money(pretaxLeft.gt(0) ? pretaxLeft : new Big(0)),
      pretax_accounts: rollover
        ? pretax
            .filter((a) => balance(a).gt(0))
            .map((a) => ({ ...(ref(a) as AccountRef), balance: money(balance(a)) }))
        : [],
      rollover_into: rollover ? plan : null,
      match,
      conversion_tax_rate: conversionRate.toFixed(),
      conversion_tax_rate_assumed: route === "backdoor" && !planRate,
    };
    out.items.push({
      key: `roth_ira:${year}`,
      category: "securities",
      detector: "roth_ira",
      summary:
        kind === "contribute"
          ? `Your ${year} Roth IRA room of ${whole(amount)}${projected} is unused, and it closes on April 15, ${year + 1}. Money there grows tax-free for good.${how}${matched}`
          : `${whole(amount)} put in a traditional IRA for ${year} hasn't been converted to Roth yet. Until it is, its growth is taxed, and pre-tax money left there on December 31 makes the conversion partly taxable.`,
      annual_cost: money(cost),
      currency: "USD",
      account_ids: [roth?.id, route === "backdoor" ? traditional?.id : undefined].filter(
        (x): x is string => !!x,
      ),
      product_id: null,
      action:
        kind === "convert"
          ? `Convert the ${whole(amount)} in your traditional IRA to Roth`
          : route === "backdoor"
            ? `Do a ${whole(amount)} backdoor Roth IRA for ${year}`
            : `Put ${whole(amount)} in your Roth IRA for ${year}`,
      inputs: inputs as unknown as Record<string, unknown>,
    });
  }
  return out;
}

/** What an approved IRA action puts on its tax year's record once it's carried out. */
export function recordedBy(inputs: Partial<RothIraInputs>): {
  year: number;
  add: { roth?: string; traditional?: string; converted?: string };
} | null {
  if (!inputs.tax_year || !inputs.amount) return null;
  if (inputs.kind === "convert")
    return { year: inputs.tax_year, add: { converted: inputs.amount } };
  return inputs.route === "direct"
    ? { year: inputs.tax_year, add: { roth: inputs.amount } }
    : { year: inputs.tax_year, add: { traditional: inputs.amount, converted: inputs.amount } };
}

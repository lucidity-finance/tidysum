import Big from "big.js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { account, workplacePlan } from "../db/schema.js";
import type { AgentDb } from "../mcp/agentDb.js";
import type { Misallocation } from "../misallocation/detect.js";
import type { SnapshotAccount, SnapshotHolding } from "../policy/snapshot.js";
import { capShares } from "../portfolio/allocation.js";
import { findOverlaps, WINDOW } from "../portfolio/overlap.js";
import {
  classOf,
  type SecurityCatalog,
  sleeveLabel,
  sleeveName,
} from "../portfolio/securityCatalog.js";
import { electiveDeferralLimit } from "./limits.js";

// A workplace retirement plan (a 401(k)) seen from the inside. Plaid shows its holdings but not
// the elections behind them: how much of each paycheck goes in, pre-tax or Roth, how much has gone
// in this year, the match, where each paycheck is invested and what each fund in the plan costs.
// The owner's agent reads those off the plan's site and records them here (`tidysum workplace
// set`), and two detectors price what they show (decision 0003):
//
// - retirement_rate: contributions that fall short of the year's limit (the tax a pre-tax dollar
//   saves is lost for good once the year ends), or that reach it before the last paycheck (the
//   paychecks after it get no match, unless the plan trues up).
// - fund_fee: a plan fund that costs more than a copy of it in the plan's own index funds.
// - brokerage_window: money in the plan's brokerage window (Schwab PCRA and the like), a second
//   account to sign in to and trade by hand, priced as what its funds cost over a copy in the
//   plan's own index funds. Moving it back is tax-free and keeps what it holds.
//
// A copy is faithful or it isn't made (decision 0007): it is built from what the fund actually
// holds, by the fund's own published breakdown, each sleeve (US large caps, US small and mid caps,
// international stocks, bonds) going to the plan fund that holds exactly that sleeve. A fund whose
// breakdown isn't recorded, or is out of date, is not guessed at: Tidysum asks for its fact sheet.
// A sleeve the plan has no fund for stays where it is.
//
// All are investment advice, so they run only for users with investing enabled.

const decimal = z.string().regex(/^\d{1,12}(\.\d{1,4})?$/, "must be a decimal string like 12.5");
const percent = decimal.refine((s) => new Big(s).lte(100), "must be at most 100");
const fraction = decimal.refine((s) => new Big(s).lte(1), "must be at most 1");

const LineupFund = z
  .object({
    name: z.string().trim().min(1).max(120),
    /** Yearly cost in percent, like "0.27". */
    expense_ratio: percent,
    kind: z.enum([
      "index",
      "active",
      "target_date",
      "stable_value",
      "brokerage_window",
      "company_stock",
    ]),
    /**
     * What the fund actually holds, by asset class or sleeve from catalog/securities.json
     * ("us_stocks.large"), adding up to 1. A fund holding one sleeve says so by its name; one
     * holding several (a target-date fund) needs its published breakdown, with its source and
     * date (decision 0007). Without one Tidysum won't swap it for anything.
     */
    mix: z.record(sleeveName, fraction).optional(),
    /** Where a several-sleeve mix comes from: the fact sheet's URL or name. */
    mix_source: z.string().trim().min(1).max(200).optional(),
    /** The date the source states that mix for. */
    mix_as_of: z.iso.date().optional(),
  })
  .strict()
  .refine(
    (f) =>
      !f.mix ||
      Object.values(f.mix)
        .reduce((s, v) => s.plus(v), new Big(0))
        .eq(1),
    "a fund's mix must add up to 1",
  )
  .refine(
    (f) =>
      !f.mix ||
      (Object.keys(f.mix).length === 1 && f.kind !== "target_date") ||
      (f.mix_source && f.mix_as_of),
    "a target-date fund's mix, or any mix of several sleeves, needs mix_source and mix_as_of",
  );

export const WorkplaceFactsSchema = z
  .object({
    plan_name: z.string().trim().min(1).max(120),
    /** Where the agent signs in to change elections. */
    site_url: z
      .url()
      .refine((u) => u.startsWith("https://"), "must be https")
      .optional(),
    /** The day these were read off the plan's site. */
    as_of: z.iso.date(),
    pay: z
      .object({
        /** Yearly base pay. */
        salary: decimal,
        paychecks_per_year: z.union([z.literal(12), z.literal(24), z.literal(26), z.literal(52)]),
        /**
         * The year's paydays, from the payroll calendar or paystubs, when they aren't the usual
         * ones: twice a month (the 15th and the last day) and monthly (the last day), each moved
         * back to the Friday before when it falls on a weekend.
         */
        pay_dates: z.array(z.iso.date()).max(120).optional(),
        /** One real payday, which every other one follows from when paid every 1 or 2 weeks. */
        last_pay_date: z.iso.date().optional(),
        /** How many days before a payday a change to the elections must be in to reach it. */
        cutoff_days: z.number().int().min(0).max(31).optional(),
        /** Expected yearly bonus or incentive pay, if any. */
        bonus: decimal.optional(),
      })
      .strict(),
    contributions: z
      .object({
        year: z.number().int().min(2000).max(2100),
        /** Pre-tax plus Roth contributed from pay so far this year: what counts toward the limit. */
        ytd_employee: decimal,
        /** Percent of base pay. */
        base: z
          .object({
            pretax: percent,
            roth: percent.default("0"),
            after_tax: percent.default("0"),
          })
          .strict(),
        /** Percent of bonus pay, when the plan elects it separately. */
        bonus: z
          .object({ pretax: percent, roth: percent.default("0") })
          .strict()
          .optional(),
        /** The most the plan lets one contribute, in percent of pay. */
        max_percent: percent.default("75"),
      })
      .strict(),
    match: z
      .object({
        /** The match covers contributions up to this percent of pay. */
        up_to_percent: percent,
        /** Match per dollar contributed, "1" for 100%. */
        rate: decimal.refine((s) => new Big(s).lte(2), "must be at most 2").default("1"),
        /** Whether the plan makes up at year end a match missed by reaching the limit early. */
        true_up: z.boolean().default(false),
      })
      .strict(),
    /** Which kind of contribution the owner's plan prefers for new money. */
    prefer: z.enum(["pretax", "roth"]).default("pretax"),
    /** Federal plus state income tax on the last dollar earned, like "0.24". */
    marginal_tax_rate: fraction,
    /** How each paycheck's contribution is invested, adding up to 100. */
    paycheck_investments: z
      .array(z.object({ fund: z.string().trim().min(1).max(120), percent }).strict())
      .max(30)
      .default([]),
    /** Every fund the plan offers, with its yearly cost. */
    lineup: z.array(LineupFund).max(80).default([]),
    /**
     * Tickers in the brokerage window the owner chose to sell even though no plan fund copies
     * them (decision 0007): their money goes back in the same split as the rest of the window.
     */
    window_also_sell: z
      .array(z.string().regex(/^[A-Z0-9.-]{1,12}$/))
      .max(30)
      .default([]),
    /**
     * A plan fund whose recorded mix each paycheck copies, sleeve by sleeve in the plan's index
     * funds (decision 0007), when the owner wants paychecks to match it rather than steer toward
     * the policy's target mix.
     */
    paychecks_mirror: z.string().trim().min(1).max(120).optional(),
    /**
     * Plan funds the data source reports under another security's name or ticker (Plaid has
     * matched a ticker-less plan fund to an unrelated stock): `reported` is that name or ticker,
     * `fund` the lineup fund it really is, as the plan's own site shows it.
     */
    holding_names: z
      .array(
        z
          .object({
            reported: z.string().trim().min(1).max(120),
            fund: z.string().trim().min(1).max(120),
          })
          .strict(),
      )
      .max(30)
      .default([]),
  })
  .strict()
  .refine(
    (f) =>
      f.paycheck_investments.length === 0 ||
      f.paycheck_investments.reduce((s, p) => s.plus(p.percent), new Big(0)).eq(100),
    "paycheck_investments must add up to 100",
  );

export type WorkplaceFacts = z.infer<typeof WorkplaceFactsSchema>;
export type LineupFund = z.infer<typeof LineupFund>;

export function parseWorkplaceFacts(json: unknown): WorkplaceFacts {
  const r = WorkplaceFactsSchema.safeParse(json);
  if (!r.success) {
    throw new Error(
      `invalid workplace plan: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    );
  }
  return r.data;
}

/** Records a plan's facts for one of the user's accounts, replacing what was there. */
export async function setWorkplacePlan(
  db: Db,
  userId: string,
  accountId: string,
  json: unknown,
): Promise<WorkplaceFacts> {
  const facts = parseWorkplaceFacts(json);
  const [owned] = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.id, accountId), eq(account.userId, userId)));
  if (!owned) throw new Error(`no account ${accountId} for this user`);
  await db
    .insert(workplacePlan)
    .values({ accountId, userId, facts, asOf: facts.as_of })
    .onConflictDoUpdate({
      target: workplacePlan.accountId,
      set: { facts, asOf: facts.as_of, updatedAt: new Date() },
    });
  return facts;
}

export interface StoredPlan {
  account_id: string;
  facts: WorkplaceFacts;
}

/** The agent's own user's plans, through row-level security; unreadable ones become warnings. */
export async function readWorkplacePlans(
  db: AgentDb,
  warnings: string[] = [],
): Promise<StoredPlan[]> {
  const { rows } = await db.query<{ account_id: string; facts: unknown }>(
    "select account_id, facts from workplace_plan order by account_id",
  );
  return rows.flatMap((r) => {
    const parsed = WorkplaceFactsSchema.safeParse(r.facts);
    if (parsed.success) return [{ account_id: r.account_id, facts: parsed.data }];
    warnings.push("A recorded workplace plan no longer reads; record it again.");
    return [];
  });
}

/**
 * A plan account's holding under the lineup fund it really is, when the plan's facts say the data
 * source reports that fund as something else (`holding_names`, matched on name or ticker). The
 * fund has no ticker of its own, so the reported one is dropped.
 */
export function asPlanFund<
  H extends { ticker_symbol: string | null; security_name: string | null },
>(f: Pick<WorkplaceFacts, "holding_names" | "lineup">, h: H): H {
  const reported = [h.security_name, h.ticker_symbol].flatMap((x) => (x ? [normal(x)] : []));
  const alias = f.holding_names.find((a) => reported.includes(normal(a.reported)));
  const fund = alias ? findFund(f.lineup, alias.fund) : undefined;
  return fund ? { ...h, security_name: fund.name, ticker_symbol: null } : h;
}

// The plan's funds ----------------------------------------------------------------------------

const normal = (s: string) =>
  s
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function findFund(lineup: LineupFund[], name: string | null): LineupFund | undefined {
  if (!name) return undefined;
  const n = normal(name);
  return lineup.find((f) => normal(f.name) === n);
}

const cheapestFirst = (a: LineupFund, b: LineupFund) =>
  new Big(a.expense_ratio).cmp(b.expense_ratio) ||
  Number(b.kind === "index") - Number(a.kind === "index");

/** Funds a copy or new money can go to: not the brokerage window, not company stock. */
const buyable = (f: LineupFund) => f.kind !== "brokerage_window" && f.kind !== "company_stock";

/**
 * The cheapest plan fund holding only asset class `cls` (any of its sleeves), index funds first
 * on a tie. For new money, which goes to a class; never for copying a fund.
 */
export function cheapestIn(lineup: LineupFund[], cls: string): LineupFund | null {
  const only = lineup.filter((f) => {
    const keys = Object.keys(f.mix ?? {});
    return keys.length > 0 && keys.every((k) => classOf(k) === cls) && buyable(f);
  });
  return only.sort(cheapestFirst)[0] ?? null;
}

/** The cheapest plan fund holding exactly `sleeve` and nothing else. */
export function cheapestHolding(lineup: LineupFund[], sleeve: string): LineupFund | null {
  const only = lineup.filter((f) => {
    const keys = Object.keys(f.mix ?? {});
    return keys.length === 1 && keys[0] === sleeve && buyable(f);
  });
  return only.sort(cheapestFirst)[0] ?? null;
}

/** How long a several-sleeve fund's breakdown holds before it has to be read again. */
const MIX_FRESH_DAYS = 400;

/**
 * What a plan fund actually holds, when that is known well enough to copy: recorded, and for a
 * fund of several sleeves (target-date funds move every year) no older than about a year.
 * Otherwise why not, in words for the owner.
 */
export function recordedMix(
  fund: LineupFund,
  planName: string,
  today: string,
): { mix: Record<string, Big> } | { why: string } {
  if (!fund.mix) {
    return {
      why: `To copy ${fund.name} in ${planName} with cheaper funds, Tidysum needs what it actually holds, from its fact sheet; it won't guess. Your agent records it with the plan's facts (the fund's mix, mix_source and mix_as_of).`,
    };
  }
  if (Object.keys(fund.mix).length > 1 && fund.mix_as_of) {
    const age =
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${fund.mix_as_of}T00:00:00Z`)) / 86_400_000;
    if (age > MIX_FRESH_DAYS) {
      return {
        why: `${fund.name}'s recorded mix in ${planName} is from ${fund.mix_as_of}, and funds like it change every year. Your agent reads its fact sheet again before Tidysum copies it.`,
      };
    }
  }
  return { mix: Object.fromEntries(Object.entries(fund.mix).map(([k, v]) => [k, new Big(v)])) };
}

export interface Copy {
  /** Each sleeve with its share and the plan fund holding exactly it. */
  parts: { sleeve: string; share: Big; fund: LineupFund }[];
  /** Sleeves no plan fund holds on its own. */
  missing: string[];
}

/**
 * A faithful copy of a split in the plan's own funds (decision 0007): each sleeve goes to the
 * cheapest plan fund holding exactly that sleeve. A sleeve no plan fund holds on its own is
 * missing, and nothing stands in for it: not a broader fund, not a neighbouring one.
 */
export function copyOf(lineup: LineupFund[], mix: Record<string, Big>): Copy {
  const out: Copy = { parts: [], missing: [] };
  for (const [sleeve, share] of Object.entries(mix)) {
    if (share.lte(0)) continue;
    const fund = cheapestHolding(lineup, sleeve);
    if (fund) out.parts.push({ sleeve, share, fund });
    else out.missing.push(sleeve);
  }
  return out;
}

export interface CopyRow {
  sleeve: string;
  label: string;
  /** Percent of the original in this sleeve, like "46.28". */
  holds: string;
  fund: string;
  /** Whole percent the copy puts in `fund`. */
  percent: number;
  /** Sold by the owner's choice with no plan fund to copy it: spread like the rest. */
  spread?: boolean;
}

/** A copy side by side with what it copies: each sleeve, its share, and the whole percent for it. */
export function copyRows(copy: Copy, catalog: SecurityCatalog | undefined): CopyRow[] {
  const total = copy.parts.reduce((s, p) => s.plus(p.share), new Big(0));
  const percents = roundedPercents(
    copy.parts.map((p) => p.share),
    1,
  );
  return copy.parts
    .map((p, i) => ({
      sleeve: p.sleeve,
      label: sleeveLabel(catalog, p.sleeve),
      holds: trimZeros(p.share.div(total).times(100).toFixed(2)),
      fund: p.fund.name,
      percent: percents[i] ?? 0,
      share: p.share,
    }))
    .sort((a, b) => b.share.cmp(a.share))
    .map(({ share: _, ...row }) => row);
}

const trimZeros = (s: string) => s.replace(/\.?0+$/, "");

/** "46.28% US large-cap stocks, 11.56% ... and 11% bonds". */
const describeHolds = (rows: CopyRow[]) =>
  joinAnd(rows.map((r) => `${r.holds}% ${lowerFirst(r.label)}`));

const lowerFirst = (s: string) => s.replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase());

function joinAnd(parts: string[]): string {
  if (parts.length < 2) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** Shares rounded to multiples of `step` percent that add up to 100, by largest remainder. */
export function roundedPercents(shares: Big[], step = 5): number[] {
  const total = shares.reduce((s, x) => s.plus(x), new Big(0));
  if (total.lte(0)) return shares.map(() => 0);
  const units = 100 / step;
  const raw = shares.map((x) => x.div(total).times(units));
  const floors = raw.map((x) => Number(x.round(0, Big.roundDown)));
  let left = units - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, rem: x.minus(floors[i] ?? 0) }))
    .sort((a, b) => b.rem.cmp(a.rem));
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    left--;
  }
  return floors.map((f) => f * step);
}

/**
 * The plan's funds for a split by asset class: for each part, the cheapest fund holding only
 * that class (any of them, for a part spanning several). Parts the plan has no fund for are left
 * out and the rest scaled up; with a `cap`, no part ends up above it, the excess going to the
 * other parts by their `target`. Null when no part has a fund.
 */
export function planFundsFor(
  lineup: LineupFund[],
  parts: { classes: string[]; share: Big; target?: Big }[],
  step = 1,
  cap?: Big,
): { fund: string; percent: number }[] | null {
  const found = parts.flatMap((p, i) => {
    const options = p.classes
      .map((c) => cheapestIn(lineup, c))
      .filter((f): f is LineupFund => !!f)
      .sort((a, b) => new Big(a.expense_ratio).cmp(b.expense_ratio));
    const fund = options[0];
    return fund && p.share.gt(0)
      ? [{ key: String(i), fund, share: p.share, target: p.target ?? p.share }]
      : [];
  });
  if (found.length === 0) return null;
  const capped = cap
    ? capShares(
        found,
        found.map((f) => ({ key: f.key, target: f.target })),
        cap,
      )
    : found;
  const picked = found.map((f, i) => ({ fund: f.fund, share: capped[i]?.share ?? f.share }));
  // Two parts can land on the same fund: add them up.
  const merged = new Map<string, Big>();
  for (const p of picked)
    merged.set(p.fund.name, (merged.get(p.fund.name) ?? new Big(0)).plus(p.share));
  const names = [...merged.keys()];
  const percents = roundedPercents(
    names.map((n) => merged.get(n) ?? new Big(0)),
    step,
  );
  return names.map((fund, i) => ({ fund, percent: percents[i] ?? 0 })).filter((p) => p.percent > 0);
}

/**
 * How each paycheck is invested when the owner chose to match a plan fund (`paychecks_mirror`):
 * a faithful copy of its recorded mix in the plan's own funds. Null, with why, when the fund isn't
 * in the lineup, has no recorded mix, or has a sleeve the plan can't copy.
 */
/** The copy of the plan fund the owner's paychecks match (`paychecks_mirror`), or why there is none. */
function mirrorCopy(
  f: WorkplaceFacts,
): { fund: string; copy: Copy } | { fund: string; why: string } | null {
  if (!f.paychecks_mirror) return null;
  const fund = findFund(f.lineup, f.paychecks_mirror);
  const name = fund?.name ?? f.paychecks_mirror;
  if (!fund?.mix) {
    return {
      fund: name,
      why: `${f.plan_name}'s paychecks are set to match ${name}, but its mix isn't recorded from its fact sheet, so Tidysum doesn't say where they go.`,
    };
  }
  const copy = copyOf(
    f.lineup,
    Object.fromEntries(Object.entries(fund.mix).map(([k, v]) => [k, new Big(v)])),
  );
  if (copy.missing.length) {
    return {
      fund: name,
      why: `${f.plan_name}'s paychecks are set to match ${name}, but the plan has no fund holding only ${joinAnd(copy.missing)}.`,
    };
  }
  return { fund: name, copy };
}

export function paycheckMirror(
  f: WorkplaceFacts,
):
  | { fund: string; into: { fund: string; percent: number }[] }
  | { fund: string; why: string }
  | null {
  const m = mirrorCopy(f);
  if (!m || "why" in m) return m;
  return { fund: m.fund, into: intoOf(copyRows(m.copy, undefined)) };
}

const intoOf = (rows: CopyRow[]) =>
  rows.filter((r) => r.percent > 0).map((r) => ({ fund: r.fund, percent: r.percent }));

export const describeSplit = (split: { fund: string; percent: number }[]) =>
  split.map((s) => `${s.percent}% ${s.fund}`).join(", ");

// Detection -----------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

type Pay = Pick<WorkplaceFacts["pay"], "paychecks_per_year"> &
  Partial<Pick<WorkplaceFacts["pay"], "pay_dates" | "last_pay_date" | "cutoff_days">>;

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** The day itself, or the Friday before it when it falls on a weekend. */
function weekdayOnOrBefore(year: number, month: number, day: number): string {
  const ms = Date.UTC(year, month, day);
  const dow = new Date(ms).getUTCDay();
  return iso(ms - (dow === 6 ? 1 : dow === 0 ? 2 : 0) * DAY_MS);
}

/**
 * A year's paydays, in order: the recorded ones; or the usual ones for pay twice a month (the
 * 15th and the last day) or monthly (the last day), moved back to the Friday before a weekend; or,
 * for pay every 1 or 2 weeks, every 7 or 14 days from a real payday. Null when they can't be told.
 */
export function paydays(year: number, pay: Pay): string[] | null {
  const recorded = pay.pay_dates?.filter((d) => d.startsWith(`${year}-`));
  if (recorded?.length) return [...new Set(recorded)].sort();
  const n = pay.paychecks_per_year;
  if (n === 24 || n === 12) {
    const out: string[] = [];
    for (let m = 0; m < 12; m++) {
      if (n === 24) out.push(weekdayOnOrBefore(year, m, 15));
      out.push(weekdayOnOrBefore(year, m + 1, 0));
    }
    return out;
  }
  if (!pay.last_pay_date) return null;
  const step = (n === 52 ? 7 : 14) * DAY_MS;
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  const anchor = dayMs(pay.last_pay_date);
  let t = anchor - Math.ceil((anchor - start) / step) * step;
  const out: string[] = [];
  for (; t < end; t += step) out.push(iso(t));
  return out;
}

/**
 * Paychecks a change made today still reaches this year: paydays after today plus the payroll
 * cutoff. When the paydays can't be told, the year's paychecks spread evenly over it.
 */
export function paychecksLeft(today: string, pay: Pay | number): number {
  const p: Pay =
    typeof pay === "number" ? { paychecks_per_year: pay as Pay["paychecks_per_year"] } : pay;
  const year = Number(today.slice(0, 4));
  const days = paydays(year, p);
  if (days) {
    const from = iso(dayMs(today) + (p.cutoff_days ?? 0) * DAY_MS);
    return days.filter((d) => d > from).length;
  }
  const length = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / DAY_MS;
  const after = (Date.UTC(year + 1, 0, 1) - dayMs(today)) / DAY_MS - 1;
  return Math.max(0, Math.ceil((p.paychecks_per_year * after) / length - 1e-9));
}

/** Days before a payday a change has to be in, when the plan's cutoff isn't recorded. */
const USUAL_CUTOFF_DAYS = 10;

/**
 * When next year's percent can be set (decision 0006): after this year's last payday, so it
 * doesn't change this year's paychecks, and before the cutoff for next year's first one.
 */
export function nextYearWindow(
  year: number,
  pay: Pay,
): { not_before: string; due_by: string | null } {
  const last = paydays(year, pay)?.at(-1);
  const notBefore = last ? iso(dayMs(last) + DAY_MS) : `${year + 1}-01-01`;
  const first = paydays(year + 1, pay)?.[0];
  if (!first) return { not_before: notBefore, due_by: null };
  const due = iso(dayMs(first) - (pay.cutoff_days ?? USUAL_CUTOFF_DAYS) * DAY_MS);
  // A cutoff before the window opens leaves only its first day.
  if (due < notBefore) return { not_before: notBefore, due_by: notBefore };
  return { not_before: notBefore, due_by: due };
}

export interface RateChange {
  kind: "raise" | "lower";
  year: number;
  /** Whether it is about the rest of this year (or else all of next year). */
  this_year: boolean;
  current_percent: string;
  new_percent: string;
  /** Paychecks the new percent covers. */
  paychecks: number;
  /** Raise: tax saved on the extra pre-tax contributions. Lower: match no longer missed. */
  value: Big;
  /** Lower: paychecks that would get no match. */
  unmatched: number;
  limit: string;
  limit_official: boolean;
  limit_source: string;
}

const pctText = (b: Big) => b.toFixed(b.round(0).eq(b) ? 0 : 1);
const bigMin = (a: Big, b: Big) => (a.lt(b) ? a : b);

/**
 * What the contribution percent should be, if not what it is: high enough to reach the limit
 * (pre-tax money saves tax only in its own year), low enough to reach it only with the last
 * paycheck (later paychecks lose their match). Late in the year, when two paychecks or fewer are
 * left, it looks at next year instead, which has to be set before its first paycheck.
 */
export function rateChange(
  f: WorkplaceFacts,
  today: string,
): { change: RateChange | null; warning?: string } {
  const year = Number(today.slice(0, 4));
  const c = f.contributions;
  if (c.year !== year) {
    return {
      change: null,
      warning: `${f.plan_name}: contributions are recorded for ${c.year}, not ${year}; record them again.`,
    };
  }
  const perYear = f.pay.paychecks_per_year;
  const perPay = new Big(f.pay.salary).div(perYear);
  if (perPay.lte(0)) return { change: null };
  const left = paychecksLeft(today, f.pay);
  const employee = new Big(c.base.pretax).plus(c.base.roth);
  const matchUpTo = new Big(f.match.up_to_percent);
  const matchPerPay = perPay.times(matchUpTo).div(100).times(f.match.rate);
  const max = new Big(c.max_percent);
  const marginal = new Big(f.marginal_tax_rate);
  const slack = perPay.div(100); // one percent of a paycheck

  const now = electiveDeferralLimit(year);
  if (left > 0 && now) {
    const room = now.value.minus(c.ytd_employee);
    if (room.gt(slack)) {
      const per = perPay.times(employee).div(100);
      const fill = bigMin(room.div(perPay.times(left)).times(100).round(0, Big.roundDown), max);
      const base = {
        year,
        this_year: true,
        current_percent: pctText(employee),
        paychecks: left,
        limit: now.amount,
        limit_official: now.official,
        limit_source: now.source_url,
      };
      if (per.times(left).lt(room.minus(slack)) && fill.gt(employee)) {
        const added = perPay.times(fill.minus(employee)).div(100).times(left);
        return {
          change: {
            ...base,
            kind: "raise",
            new_percent: pctText(fill),
            value: added.times(marginal),
            unmatched: 0,
          },
        };
      }
      if (!f.match.true_up && per.gt(0)) {
        const reachedOn = Number(room.div(per).round(0, Big.roundUp));
        const unmatched = left - reachedOn;
        if (unmatched >= 1 && fill.gte(matchUpTo)) {
          return {
            change: {
              ...base,
              kind: "lower",
              new_percent: pctText(fill),
              value: matchPerPay.times(unmatched),
              unmatched,
            },
          };
        }
      }
    }
  }

  if (left > 2) return { change: null };
  const next = electiveDeferralLimit(year + 1);
  if (!next) return { change: null };
  const salary = new Big(f.pay.salary);
  const bonus = new Big(f.pay.bonus ?? 0);
  const bonusPct = c.bonus ? new Big(c.bonus.pretax).plus(c.bonus.roth) : employee;
  const planned = salary.times(employee).div(100).plus(bonus.times(bonusPct).div(100));
  const fill = bigMin(next.value.div(salary.plus(bonus)).times(100).round(0, Big.roundDown), max);
  const base = {
    year: year + 1,
    this_year: false,
    current_percent: pctText(employee),
    paychecks: perYear,
    limit: next.amount,
    limit_official: next.official,
    limit_source: next.source_url,
  };
  if (planned.lt(next.value.minus(slack)) && fill.gt(employee)) {
    const added = salary.plus(bonus).times(fill).div(100).minus(planned);
    return {
      change: {
        ...base,
        kind: "raise",
        new_percent: pctText(fill),
        value: added.times(marginal),
        unmatched: 0,
      },
    };
  }
  const per = perPay.times(employee).div(100);
  if (!f.match.true_up && per.gt(0) && planned.gt(next.value.plus(slack))) {
    // A bonus usually comes early in the year, so count it first.
    const afterBonus = next.value.minus(bonus.times(bonusPct).div(100));
    const reachedOn = afterBonus.lte(0) ? 0 : Number(afterBonus.div(per).round(0, Big.roundUp));
    const unmatched = perYear - reachedOn;
    if (unmatched >= 1 && fill.gte(matchUpTo)) {
      return {
        change: {
          ...base,
          kind: "lower",
          new_percent: pctText(fill),
          value: matchPerPay.times(unmatched),
          unmatched,
        },
      };
    }
  }
  return { change: null };
}

const slug = (s: string) => normal(s).replace(/ /g, "-").slice(0, 60);
const money = (b: Big) => b.toFixed(2);

export interface WorkplaceDetection {
  items: Misallocation[];
  warnings: string[];
  /** Each plan account's current contribution percent, to tell a change made from one gone quiet. */
  percents: Record<string, string>;
  /** Whether a plan's contributions are current, so retirement_rate findings can close. */
  rates_current: boolean;
  /** Findings that couldn't be decided for want of a fact (a fund's mix): leave them be. */
  undecided: string[];
  /** The plan funds each plan account holds, by their lineup names. */
  funds: Record<string, string[]>;
  /** The tickers in each plan account's brokerage window, when the window is linked. */
  window_tickers: Record<string, string[]>;
}

export function workplaceFindings(
  plans: StoredPlan[],
  holdings: SnapshotHolding[],
  catalog: SecurityCatalog | undefined,
  today: string,
  accounts: SnapshotAccount[] = [],
): WorkplaceDetection {
  const out: WorkplaceDetection = {
    items: [],
    warnings: [],
    percents: {},
    rates_current: false,
    undecided: [],
    funds: {},
    window_tickers: {},
  };
  const year = Number(today.slice(0, 4));
  for (const { account_id, facts: f } of plans) {
    const employee = new Big(f.contributions.base.pretax).plus(f.contributions.base.roth);
    out.percents[account_id] = pctText(employee);
    const where = {
      plan_name: f.plan_name,
      site_url: f.site_url ?? null,
      facts_as_of: f.as_of,
    };

    const { change, warning } = rateChange(f, today);
    if (warning) out.warnings.push(warning);
    else out.rates_current = true;
    if (change) {
      const bonus = f.contributions.bonus;
      const rothToPretax =
        f.prefer === "pretax" &&
        (new Big(f.contributions.base.roth).gt(0) || (!!bonus && new Big(bonus.roth).gt(0)));
      const when = change.this_year
        ? `for the rest of ${change.year}`
        : `before your first ${change.year} paycheck`;
      const projected = change.limit_official ? "" : " (expected; the IRS hasn't announced it yet)";
      out.items.push({
        key: `retirement_rate:${account_id}:${change.year}:${change.kind}`,
        category: "securities",
        detector: "retirement_rate",
        summary:
          change.kind === "raise"
            ? `At ${change.current_percent}% of pay, your ${f.plan_name} contributions fall short of the ${change.year} limit${projected}. ${change.new_percent}% for ${change.this_year ? `the ${change.paychecks} paychecks left` : "the year"} reaches it, and pre-tax money saves tax only in its own year.`
            : `At ${change.current_percent}% of pay, your ${f.plan_name} contributions reach the ${change.year} limit${projected} with ${change.unmatched} paycheck${change.unmatched === 1 ? "" : "s"} to go, and those get no match. ${change.new_percent}% reaches it with the last paycheck.`,
        annual_cost: money(change.value),
        currency: "USD",
        account_ids: [account_id],
        product_id: null,
        action: `Set your ${f.plan_name} contributions to ${change.new_percent}% ${when}`,
        inputs: {
          ...where,
          kind: change.kind,
          year: change.year,
          this_year: change.this_year,
          current_percent: change.current_percent,
          new_percent: change.new_percent,
          paychecks: change.paychecks,
          unmatched: change.unmatched,
          bonus_too: !change.this_year && !!bonus,
          roth_to_pretax: rothToPretax,
          prefer: f.prefer,
          marginal_tax_rate: f.marginal_tax_rate,
          match_up_to_percent: f.match.up_to_percent,
          limit: change.limit,
          limit_official: change.limit_official,
          // Next year's percent waits for this year's last payday (decision 0006).
          ...(change.this_year ? {} : { window: nextYearWindow(year, f.pay) }),
        },
      });
    }

    out.funds[account_id] = [];
    for (const h of holdings.filter((x) => x.account_id === account_id)) {
      const fund = findFund(f.lineup, h.security_name);
      if (fund && new Big(h.institution_value).gt(0)) out.funds[account_id].push(fund.name);
      if (!fund || !buyable(fund) || new Big(h.institution_value).lte(0)) continue;
      const key = `fund_fee:${account_id}:${slug(fund.name)}`;
      // Nothing in the plan costs less: there is no cheaper copy to make.
      const cheaper = f.lineup.some(
        (x) =>
          buyable(x) && x.name !== fund.name && new Big(x.expense_ratio).lt(fund.expense_ratio),
      );
      if (!cheaper) continue;
      const known = recordedMix(fund, f.plan_name, today);
      if ("why" in known) {
        out.warnings.push(known.why);
        out.undecided.push(key);
        continue;
      }
      const copy = copyOf(f.lineup, known.mix);
      if (copy.missing.length) {
        out.warnings.push(
          `${f.plan_name} has no fund holding only ${joinAnd(copy.missing.map((m) => lowerFirst(sleeveLabel(catalog, m))))}, so ${fund.name} can't be copied exactly; Tidysum leaves it as it is.`,
        );
        continue;
      }
      if (copy.parts.every((p) => p.fund.name === fund.name)) continue;
      const altRatio = copy.parts.reduce(
        (s, p) => s.plus(p.share.times(p.fund.expense_ratio)),
        new Big(0),
      );
      const saving = new Big(h.institution_value)
        .times(new Big(fund.expense_ratio).minus(altRatio))
        .div(100);
      if (saving.lt(1)) continue;
      const rows = copyRows(copy, catalog);
      const several = rows.length > 1;
      const source = several && fund.mix_source ? ` (${fund.mix_source}, ${fund.mix_as_of})` : "";
      const glide =
        fund.kind === "target_date"
          ? " Unlike the fund, the copy won't shift toward bonds by itself; new money does that, by your plan."
          : "";
      out.items.push({
        key,
        category: "securities",
        detector: "fund_fee",
        summary: several
          ? `${fund.name} costs ${fund.expense_ratio}% a year. By its fact sheet${source} it holds ${describeHolds(rows)}. The plan's index funds copy that sleeve by sleeve for ${altRatio.toFixed(2)}%, tax-free inside the plan.${glide}`
          : `${fund.name} costs ${fund.expense_ratio}% a year for ${lowerFirst(rows[0]?.label ?? "what it holds")}. ${rows[0]?.fund} holds the same for ${altRatio.toFixed(2)}%, and swapping inside the plan is tax-free.`,
        annual_cost: money(saving),
        currency: "USD",
        account_ids: [account_id],
        product_id: null,
        action: `Swap ${fund.name} for the plan's index funds`,
        inputs: {
          ...where,
          fund: fund.name,
          fund_kind: fund.kind,
          expense_ratio: fund.expense_ratio,
          alternative_expense_ratio: altRatio.toFixed(4),
          mix_source: fund.mix_source ?? null,
          mix_as_of: fund.mix_as_of ?? null,
          copy: rows,
          into: rows
            .filter((r) => r.percent > 0)
            .map((r) => ({ fund: r.fund, percent: r.percent })),
          paychecks_too: f.paycheck_investments.some((p) => normal(p.fund) === normal(fund.name)),
        },
      });
    }

    const mirror = paycheckMirror(f);
    if (mirror && "why" in mirror) out.warnings.push(mirror.why);

    const window = windowFinding(account_id, f, accounts, holdings, catalog, out);
    if (window) out.items.push({ ...window, inputs: { ...where, ...window.inputs } });
  }
  return out;
}

const label = (a: SnapshotAccount) => [a.name, a.official_name ?? ""].join(" ");

/**
 * The plan's brokerage window, when it holds money: the funds in it (from the brokerage's own
 * account, which findOverlaps pairs with the plan's lump), a copy of each in the plan's own funds
 * sleeve by sleeve, and what they cost over that copy. A fund the plan can't copy stays in the
 * window, unless the owner chose to sell it anyway (`window_also_sell`): then its money goes in
 * the same split as the rest. A fund the catalog doesn't know leaves the whole move undecided.
 */
function windowFinding(
  account_id: string,
  f: WorkplaceFacts,
  accounts: SnapshotAccount[],
  holdings: SnapshotHolding[],
  catalog: SecurityCatalog | undefined,
  out: Pick<WorkplaceDetection, "warnings" | "undecided" | "window_tickers">,
): Misallocation | null {
  const window = f.lineup.find((x) => x.kind === "brokerage_window");
  if (!window) return null;
  const key = `brokerage_window:${account_id}`;
  const pair = findOverlaps(accounts, holdings).find((o) => o.account_id === account_id);
  if (!pair) {
    // The plan still reports money in its window and a window account is linked, but they don't
    // match today: the plan and the brokerage price it on different days, so the two drift apart
    // in a fast market. That says nothing about whether the move was made, so the finding stays.
    const lump = holdings.some(
      (h) =>
        h.account_id === account_id &&
        findFund([window], h.security_name) &&
        new Big(h.institution_value).gt(0),
    );
    const linked = accounts.some(
      (a) => a.id !== account_id && a.type === "investment" && WINDOW.test(label(a)),
    );
    if (lump && linked) out.undecided.push(key);
    return null;
  }
  const held = holdings.filter(
    (h) => h.account_id === pair.same_as_account_id && new Big(h.institution_value).gt(0),
  );
  out.window_tickers[account_id] = held.flatMap((h) =>
    h.ticker_symbol ? [h.ticker_symbol.toUpperCase()] : [],
  );
  if (held.length === 0) return null;
  const byTicker = new Map(catalog?.securities.map((s) => [s.ticker, s]) ?? []);
  const sleeves = new Map<string, Big>();
  const funds: { name: string; ticker: string | null; expense_ratio: string | null }[] = [];
  const stays: { name: string; ticker: string | null; missing: string[] }[] = [];
  const spread: typeof stays = [];
  const alsoSell = new Set(f.window_also_sell.map((t) => t.toUpperCase()));
  // The owner's paychecks match a plan fund: the window's money goes into the same copy.
  const mirror = mirrorCopy(f);
  const matches = mirror && "copy" in mirror ? mirror : null;
  /** What the window holds, by sleeve, across every fund that moves. */
  const held_by_sleeve = new Map<string, Big>();
  const hold = (mix: Record<string, Big.BigSource>, value: Big) => {
    for (const [k, v] of Object.entries(mix))
      held_by_sleeve.set(k, (held_by_sleeve.get(k) ?? new Big(0)).plus(value.times(v)));
  };
  /** What the copy is made of. */
  let total = new Big(0);
  /** Sold although uncopied, by the owner's choice: spread like the rest. */
  let spreadValue = new Big(0);
  let cost = new Big(0);
  for (const h of held) {
    const value = new Big(h.institution_value);
    const known = h.ticker_symbol ? byTicker.get(h.ticker_symbol.toUpperCase()) : undefined;
    const cash = h.is_cash_equivalent || h.security_type === "cash";
    const mix: Record<string, Big.BigSource> | null = known ? known.mix : cash ? { cash: 1 } : null;
    if (!mix) {
      out.warnings.push(
        `To copy ${h.ticker_symbol ?? h.security_name ?? "a fund"} in ${f.plan_name}'s brokerage window, Tidysum needs what it holds in catalog/securities.json; it won't guess.`,
      );
      out.undecided.push(key);
      return null;
    }
    const name = known?.name ?? h.security_name ?? h.ticker_symbol ?? "a fund";
    const copy = copyOf(
      f.lineup,
      Object.fromEntries(Object.entries(mix).map(([k, v]) => [k, new Big(v)])),
    );
    if (copy.missing.length) {
      if (cash) continue;
      const fund = {
        name,
        ticker: h.ticker_symbol,
        missing: copy.missing.map((m) => lowerFirst(sleeveLabel(catalog, m))),
      };
      if (h.ticker_symbol && alsoSell.has(h.ticker_symbol.toUpperCase())) {
        spread.push(fund);
        spreadValue = spreadValue.plus(value);
        hold(mix, value);
        if (known?.expense_ratio) cost = cost.plus(value.times(known.expense_ratio).div(100));
        funds.push({ name, ticker: h.ticker_symbol, expense_ratio: known?.expense_ratio ?? null });
      } else {
        stays.push(fund);
      }
      continue;
    }
    for (const p of copy.parts) {
      sleeves.set(p.sleeve, (sleeves.get(p.sleeve) ?? new Big(0)).plus(value.times(p.share)));
    }
    hold(mix, value);
    total = total.plus(value);
    if (known?.expense_ratio) cost = cost.plus(value.times(known.expense_ratio).div(100));
    if (!cash)
      funds.push({ name, ticker: h.ticker_symbol, expense_ratio: known?.expense_ratio ?? null });
  }
  const institution = pair.same_as_institution_name ?? "the brokerage";
  const missing = [...new Set(stays.flatMap((x) => x.missing))];
  const staying = joinAnd(stays.map((x) => x.name));
  if (total.lte(0) && !(matches && spreadValue.gt(0))) {
    // With nothing the plan can copy, there is no "rest" to spread a chosen sale over.
    const all = [...stays, ...spread];
    if (all.length) {
      const why = [...new Set(all.flatMap((x) => x.missing))];
      out.warnings.push(
        `${joinAnd(all.map((x) => x.name))} in ${f.plan_name}'s brokerage window can't be copied in the plan, which has no fund holding only ${joinAnd(why)}; it stays in the window.`,
      );
    }
    return null;
  }
  const moved = total.plus(spreadValue);
  // Where the money goes: a sleeve-by-sleeve copy of what the window holds, or, when the owner's
  // paychecks match a plan fund, the same copy of that fund (a change of mix, by their choice).
  const copy = matches
    ? matches.copy
    : copyOf(f.lineup, Object.fromEntries([...sleeves].map(([k, v]) => [k, v.div(total)])));
  const copied = copyRows(copy, catalog);
  const rows: CopyRow[] = matches
    ? mirrorRows(copied, held_by_sleeve, moved, catalog)
    : [
        // What the window holds, as shares of everything moved: the copied sleeves, then each
        // sold fund's uncopied sleeves, which have no plan fund of their own.
        ...copied.map((r) =>
          spread.length
            ? { ...r, holds: trimZeros(new Big(r.holds).times(total).div(moved).toFixed(2)) }
            : r,
        ),
        ...spreadRows(held, spread, byTicker, moved, catalog),
      ];
  const shares = copy.parts.reduce((s, p) => s.plus(p.share), new Big(0));
  const alt = copy.parts.reduce(
    (s, p) => s.plus(moved.times(p.share).div(shares).times(p.fund.expense_ratio).div(100)),
    new Big(0),
  );
  const saving = cost.minus(alt);
  const ratio = (b: Big) => b.div(moved).times(100).toFixed(4);
  const left = stays.length
    ? ` ${staying} ${stays.length === 1 ? "stays" : "stay"} there: the plan has no fund holding only ${joinAnd(missing)}, so ${stays.length === 1 ? "it" : "they"} can't be copied.`
    : "";
  const sold = spread.length
    ? ` ${joinAnd(spread.map((x) => x.name))} is sold too, by your choice: the plan has no fund holding only ${joinAnd([...new Set(spread.flatMap((x) => x.missing))])}, so its money goes in the same split as the rest.`
    : "";
  const into = intoOf(copied);
  const goes = matches
    ? `By your choice the money goes into a copy of ${matches.fund}, like your paychecks: ${describeSplit(into)}, for ${ratio(alt)}% a year. That changes the mix from what the window holds.`
    : `The plan's index funds copy that sleeve by sleeve for ${ratio(alt)}%.`;
  return {
    key,
    category: "securities",
    detector: "brokerage_window",
    summary: `Part of ${f.plan_name} sits in its brokerage window at ${institution}, a second account to sign in to and trade by hand. Its funds hold ${describeHolds(rows.filter((r) => r.holds !== "0"))} for ${ratio(cost)}% a year. ${goes} Moving it back is tax-free.${left}${sold}`,
    annual_cost: money(saving.gt(0) ? saving : new Big(0)),
    currency: "USD",
    account_ids: [account_id, pair.same_as_account_id],
    product_id: null,
    action: `Move ${f.plan_name}'s brokerage window back into the plan's index funds`,
    inputs: {
      window_fund: window.name,
      window_account: {
        id: pair.same_as_account_id,
        name: pair.same_as_account_name,
        institution: pair.same_as_institution_name,
      },
      funds,
      stays,
      spread,
      expense_ratio: ratio(cost),
      alternative_expense_ratio: ratio(alt),
      copy: rows,
      into,
      matches: matches?.fund ?? null,
      // Selling and buying back leaves the money out of the market for a few days: do it in a
      // calm stretch (decision 0008).
      wait_for: "calm_markets",
      paychecks_too: f.paycheck_investments.some(
        (p) => normal(p.fund) === normal(window.name) && new Big(p.percent).gt(0),
      ),
      paychecks_mirror: (() => {
        const m = paycheckMirror(f);
        return m && "into" in m ? m : null;
      })(),
    },
  };
}

/**
 * Rows for a window whose money goes into the copy of another fund: each sleeve of that copy with
 * what the window holds in it, then the window's sleeves the copy has none of (sold, no percent).
 */
function mirrorRows(
  copied: CopyRow[],
  held: Map<string, Big>,
  moved: Big,
  catalog: SecurityCatalog | undefined,
): CopyRow[] {
  const holds = (sleeve: string) =>
    trimZeros((held.get(sleeve) ?? new Big(0)).div(moved).times(100).toFixed(2));
  const sleeves = new Set(copied.map((r) => r.sleeve));
  return [
    ...copied.map((r) => ({ ...r, holds: holds(r.sleeve) })),
    ...[...held]
      .filter(([sleeve, v]) => !sleeves.has(sleeve) && v.gt(0))
      .sort((a, b) => b[1].cmp(a[1]))
      .map(([sleeve]) => ({
        sleeve,
        label: sleeveLabel(catalog, sleeve),
        holds: holds(sleeve),
        fund: "",
        percent: 0,
        spread: true,
      })),
  ];
}

/**
 * Rows for funds sold by the owner's choice although no plan fund copies them: each uncopied
 * sleeve with its share of everything moved, and no plan fund or percent of its own.
 */
function spreadRows(
  held: SnapshotHolding[],
  spread: { ticker: string | null }[],
  byTicker: Map<string, { mix: Record<string, string> }>,
  moved: Big,
  catalog: SecurityCatalog | undefined,
): CopyRow[] {
  const by = new Map<string, Big>();
  for (const x of spread) {
    const known = x.ticker ? byTicker.get(x.ticker.toUpperCase()) : undefined;
    if (!known) continue;
    for (const h of held.filter((y) => y.ticker_symbol === x.ticker)) {
      for (const [sleeve, share] of Object.entries(known.mix)) {
        const v = new Big(h.institution_value).times(share);
        by.set(sleeve, (by.get(sleeve) ?? new Big(0)).plus(v));
      }
    }
  }
  return [...by].map(([sleeve, value]) => ({
    sleeve,
    label: sleeveLabel(catalog, sleeve),
    holds: trimZeros(value.div(moved).times(100).toFixed(2)),
    fund: "",
    percent: 0,
    spread: true,
  }));
}

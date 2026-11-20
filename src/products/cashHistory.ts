import Big from "big.js";
import type { AgentDb } from "../mcp/agentDb.js";
import { cashPosition } from "../policy/engine.js";
import type { Policy } from "../policy/policy.js";
import { readSnapshot } from "../policy/snapshot.js";
import { loadActivePolicy } from "../policy/store.js";
import { readAgentRegion } from "../users.js";
import { apyFor, type Catalog, type Product } from "./catalog.js";
import { DISCLOSURE } from "./disclosure.js";

// What idle cash has already cost: each cash account's balance on every day of its history,
// the part above the user's buffer, and what that part would have earned in a high-yield
// account against the interest it actually earned.
//
// Plaid has no historical balances, so they are rebuilt from the latest balance and the posted
// transactions: the balance at the end of day d is the latest balance plus every posted amount
// after d (Plaid amounts are positive for money out). Earlier balance snapshots, when there are
// any, are compared with the rebuilt series so a gap in the transactions shows up.

/** Plaid asks for up to 730 days of transactions, so older balances can't be rebuilt. */
export const MAX_HISTORY_DAYS = 730;
const DAY_MS = 86_400_000;
const CASH_SUBTYPES = ["checking", "savings", "money market", "cash management"];
const BENCHMARK_KINDS: readonly Product["kind"][] = ["savings", "cash_management"];

const money = (b: Big) => b.toFixed(2);
const ZERO = new Big(0);

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

/**
 * The daily rate that compounds to `apy` (percent) over 365 days: exp(ln(1 + apy) / 365) - 1,
 * by series, in decimals. Paying apy/365 a day would overstate the interest slightly.
 */
export function dailyRate(apy: Big): Big {
  const a = apy.div(100);
  let ln = ZERO;
  let term = a;
  for (let k = 1; k <= 30; k++) {
    ln = k % 2 === 1 ? ln.plus(term.div(k)) : ln.minus(term.div(k));
    term = term.times(a).round(30);
  }
  const y = ln.div(365);
  let rate = ZERO;
  let power = new Big(1);
  let factorial = new Big(1);
  for (let k = 1; k <= 6; k++) {
    power = power.times(y).round(30);
    factorial = factorial.times(k);
    rate = rate.plus(power.div(factorial));
  }
  return rate.round(20);
}

export interface CashHistoryAccount {
  id: string;
  name: string;
  institution_name: string | null;
  subtype: string | null;
  currency: string | null;
  /** Latest synced balance, the anchor the history is rebuilt from. */
  latest_balance: string;
  latest_balance_on: string;
  /** Earliest posted transaction, or null when there are none. */
  first_transaction: string | null;
  /** Interest credited (INCOME_INTEREST_EARNED) on each date. */
  interest: { date: string; amount: string }[];
  /** Posted net amount per date, Plaid's sign (positive = money out). */
  flows: { date: string; amount: string }[];
  /** Each day's last balance snapshot before today, to check the rebuilt series against. */
  snapshots: { date: string; current: string }[];
}

export interface CashHistoryInput {
  today: string;
  accounts: CashHistoryAccount[];
  buffer: string;
  buffer_basis: string;
  warnings: string[];
}

/** Reads the cash accounts and the buffer from the user's active policy. */
export async function readCashHistory(db: AgentDb, today: string): Promise<CashHistoryInput> {
  const warnings: string[] = [];
  let policy: Policy | null = null;
  const { rows: hasPolicy } = await db.query("select 1 from policy_version limit 1");
  if (hasPolicy.length > 0) policy = (await loadActivePolicy(db)).policy;

  let buffer = ZERO;
  let bufferBasis = "no policy is set, so all cash counts as idle";
  let ids: string[] | null = policy?.cash.account_ids ?? null;
  if (policy) {
    const position = cashPosition(policy, await readSnapshot(db, today));
    ids = position.accounts.map((a) => a.id);
    if (position.buffer) {
      buffer = position.buffer;
      bufferBasis =
        "amount" in policy.cash.buffer
          ? "your policy's cash buffer"
          : `${policy.cash.buffer.months_of_spending} months of your recent spending, from your policy`;
    } else {
      bufferBasis = "your policy's buffer can't be computed yet, so all cash counts as idle";
    }
  } else {
    warnings.push("No policy is set, so there is no cash buffer and every dollar counts as idle.");
  }

  const { rows } = await db.query<{
    id: string;
    name: string;
    institution_name: string | null;
    subtype: string | null;
    currency: string | null;
    latest_balance: string | null;
    latest_balance_on: string | null;
    first_transaction: string | null;
  }>(
    `select a.id, a.name, i.institution_name, a.subtype, a.currency,
       latest.current::text as latest_balance,
       to_char(latest.as_of at time zone 'UTC', 'YYYY-MM-DD') as latest_balance_on,
       (select min(t.date)::text from transaction t
        where t.account_id = a.id and t.removed_at is null and not t.pending) as first_transaction
     from account a
     join item i on i.id = a.item_id
     left join lateral (
       select s.current, s.as_of from balance_snapshot s
       where s.account_id = a.id and s.current is not null
       order by s.as_of desc limit 1
     ) latest on true
     where a.type = 'depository'
       and ${ids ? "a.id = any($1::uuid[])" : "a.subtype = any($1::text[])"}
     order by i.institution_name nulls last, a.name`,
    [ids ?? CASH_SUBTYPES],
  );

  const { currency: home } = await readAgentRegion(db);
  const accounts: CashHistoryAccount[] = [];
  for (const r of rows) {
    if (r.latest_balance === null || r.latest_balance_on === null) {
      warnings.push(`${r.name} has no synced balance yet, so it is left out.`);
      continue;
    }
    if (r.currency && r.currency !== home) {
      warnings.push(`${r.name} is in ${r.currency}; only ${home} accounts are counted.`);
      continue;
    }
    const flows = await db.query<{ date: string; amount: string; interest: string | null }>(
      `select t.date::text as date, sum(t.amount)::text as amount,
         (-sum(t.amount) filter (where t.category_detailed = 'INCOME_INTEREST_EARNED'))::text
           as interest
       from transaction t
       where t.account_id = $1 and t.removed_at is null and not t.pending
         and t.date > $2::date - ${MAX_HISTORY_DAYS} and t.date <= $2::date
       group by t.date order by t.date`,
      [r.id, today],
    );
    const snapshots = await db.query<{ date: string; current: string }>(
      `select distinct on (s.as_of::date) s.as_of::date::text as date, s.current::text as current
       from balance_snapshot s
       where s.account_id = $1 and s.current is not null and s.as_of::date < $2::date
       order by s.as_of::date, s.as_of desc`,
      [r.id, today],
    );
    accounts.push({
      id: r.id,
      name: r.name,
      institution_name: r.institution_name,
      subtype: r.subtype,
      currency: r.currency,
      latest_balance: r.latest_balance,
      latest_balance_on: r.latest_balance_on,
      first_transaction: r.first_transaction,
      flows: flows.rows.map((f) => ({ date: f.date, amount: f.amount })),
      interest: flows.rows.flatMap((f) =>
        f.interest && !new Big(f.interest).eq(0) ? [{ date: f.date, amount: f.interest }] : [],
      ),
      snapshots: snapshots.rows,
    });
  }
  return { today, accounts, buffer: money(buffer), buffer_basis: bufferBasis, warnings };
}

export interface Benchmark {
  product_id: string;
  provider: string;
  name: string;
  /** Today's no-condition APY; tiers are applied to each day's idle balance. */
  apy: string;
  /** Interest the idle cash would have earned over the whole history. */
  would_have_earned: string;
  /** would_have_earned minus the interest actually earned, never below 0. */
  lost: string;
  source_url: string;
  rates_as_of: string;
  verified_on: string;
}

export interface CashHistoryMonth {
  /** YYYY-MM. The first and last months can be partial. */
  month: string;
  days: number;
  average_balance: string;
  average_idle: string;
  interest_earned: string;
  would_have_earned: string;
  lost: string;
}

export interface CashHistory {
  as_of: string;
  /** null when no account has transactions to rebuild balances from. */
  window: { from: string; to: string; days: number } | null;
  buffer: string;
  buffer_basis: string;
  /** Mean of the daily total across the cash accounts. */
  average_balance: string;
  /** Mean of the daily amount above the buffer. */
  average_idle: string;
  interest_earned: string;
  /** Best benchmark over the whole window (the headline). */
  lost: string;
  /** lost scaled to a year, so windows of different length compare. */
  lost_per_year: string;
  /** The same figures over the last 365 days only, when the window covers them. */
  last_365_days: { would_have_earned: string; interest_earned: string; lost: string } | null;
  best: Benchmark | null;
  benchmarks: Benchmark[];
  monthly: CashHistoryMonth[];
  accounts: {
    id: string;
    name: string;
    institution_name: string | null;
    latest_balance: string;
    first_transaction: string | null;
    average_balance: string;
    interest_earned: string;
    /** Earlier snapshots against the rebuilt balance on the same day. */
    check: { snapshots: number; largest_difference: string | null };
  }[];
  warnings: string[];
  assumptions: string[];
  disclosure: string;
}

const ASSUMPTIONS = [
  "Past balances are rebuilt from the latest balance and the posted transactions, so a " +
    "transaction the bank never reported would shift every day before it.",
  "Idle cash is the total across your cash accounts above your buffer, each day.",
  "Benchmarks are priced at the APY each provider pays today with no sign-up conditions. " +
    "Savings rates were higher in 2024 and 2025, so the loss further back is probably understated.",
  "Interest is compounded daily to match the APY, and is before tax.",
  "Interest you actually earned on any of these accounts, including on the buffer, is " +
    "subtracted, so the loss errs low.",
];

/**
 * An account's closing balance on each day from `from` to `to`, rebuilt from its latest balance
 * (`latest`, synced on `latestOn`) and its posted flows (Plaid's sign: positive = money out):
 * B(d) = latest + (flows dated after d, up to latestOn) - (flows dated after latestOn, up to d).
 * Flows dated before `from` cancel out, so callers only need to pass flows from `from` on.
 */
export function rebuildBalances(
  latest: string,
  latestOn: string,
  flows: { date: string; amount: string }[],
  from: string,
  to: string,
): Map<string, Big> {
  const byDay = new Map<string, Big>();
  for (const f of flows) byDay.set(f.date, (byDay.get(f.date) ?? ZERO).plus(f.amount));
  const totalUpTo = (day: string) =>
    flows.reduce((s, f) => (f.date <= day ? s.plus(f.amount) : s), ZERO);
  const base = new Big(latest).plus(totalUpTo(latestOn));
  const out = new Map<string, Big>();
  let cumulative = totalUpTo(addDays(from, -1));
  for (let d = from; d <= to; d = addDays(d, 1)) {
    cumulative = cumulative.plus(byDay.get(d) ?? ZERO);
    out.set(d, base.minus(cumulative));
  }
  return out;
}

export function cashHistory(input: CashHistoryInput, catalog: Catalog): CashHistory {
  const { today } = input;
  const warnings = [...input.warnings];
  const buffer = new Big(input.buffer);
  const starts = input.accounts.flatMap((a) => (a.first_transaction ? [a.first_transaction] : []));
  const earliest = addDays(today, -(MAX_HISTORY_DAYS - 1));
  const from = starts.sort()[0] ?? null;
  const empty = {
    as_of: today,
    buffer: input.buffer,
    buffer_basis: input.buffer_basis,
    assumptions: ASSUMPTIONS,
    disclosure: DISCLOSURE,
  };
  if (!from) {
    warnings.push("No posted transactions on your cash accounts yet, so there is no history.");
    return {
      ...empty,
      window: null,
      average_balance: "0.00",
      average_idle: "0.00",
      interest_earned: "0.00",
      lost: "0.00",
      lost_per_year: "0.00",
      last_365_days: null,
      best: null,
      benchmarks: [],
      monthly: [],
      accounts: [],
      warnings,
    };
  }
  const start = [from, earliest].sort()[1] ?? from;
  const days = daysBetween(start, today) + 1;

  const series = input.accounts.map((a) => ({
    account: a,
    // One day early, so a snapshot on the first day can be checked against the day before.
    balances: rebuildBalances(
      a.latest_balance,
      a.latest_balance_on,
      a.flows,
      addDays(start, -1),
      today,
    ),
  }));
  const total = new Map<string, Big>();
  for (let d = start; d <= today; d = addDays(d, 1)) {
    total.set(
      d,
      series.reduce((s, x) => s.plus(x.balances.get(d) ?? ZERO), ZERO),
    );
  }
  const idle = new Map([...total].map(([d, b]) => [d, b.gt(buffer) ? b.minus(buffer) : ZERO]));
  const interestOn = new Map<string, Big>();
  for (const a of input.accounts) {
    for (const i of a.interest) {
      if (i.date < start) continue;
      interestOn.set(i.date, (interestOn.get(i.date) ?? ZERO).plus(i.amount));
    }
  }
  const sumOver = (m: Map<string, Big>, keep: (d: string) => boolean = () => true) =>
    [...m].reduce((s, [d, v]) => (keep(d) ? s.plus(v) : s), ZERO);
  const interestEarned = sumOver(interestOn);

  // Each benchmark's interest per day on that day's idle balance.
  const rates = new Map<string, Big>();
  const rateFor = (apy: Big) => {
    const k = apy.toString();
    let r = rates.get(k);
    if (!r) {
      r = dailyRate(apy);
      rates.set(k, r);
    }
    return r;
  };
  const candidates = catalog.products.filter((p) => BENCHMARK_KINDS.includes(p.kind));
  const perDay = new Map<string, Map<string, Big>>();
  for (const p of candidates) {
    const earned = new Map<string, Big>();
    for (const [d, v] of idle) earned.set(d, v.times(rateFor(apyFor(p.apy, v))));
    perDay.set(p.id, earned);
  }
  const lostAgainst = (earned: Big, actual: Big) =>
    earned.gt(actual) ? earned.minus(actual) : ZERO;
  const benchmarks = candidates
    .map((p): Benchmark => {
      const earned = sumOver(perDay.get(p.id) ?? new Map());
      return {
        product_id: p.id,
        provider: p.provider,
        name: p.name,
        apy: apyFor(p.apy, ZERO).toFixed(2),
        would_have_earned: money(earned),
        lost: money(lostAgainst(earned, interestEarned)),
        source_url: p.source_url,
        rates_as_of: p.rates_as_of,
        verified_on: p.verified_on,
      };
    })
    .sort((a, b) => new Big(b.would_have_earned).cmp(a.would_have_earned));
  const best = benchmarks[0] ?? null;
  const bestDaily = best ? (perDay.get(best.product_id) ?? new Map<string, Big>()) : new Map();

  const yearStart = addDays(today, -364);
  const inYear = (d: string) => d >= yearStart;
  const last365 =
    days >= 365
      ? (() => {
          const earned = sumOver(bestDaily, inYear);
          const actual = sumOver(interestOn, inYear);
          return {
            would_have_earned: money(earned),
            interest_earned: money(actual),
            lost: money(lostAgainst(earned, actual)),
          };
        })()
      : null;

  const months = [...new Set([...total.keys()].map((d) => d.slice(0, 7)))];
  const monthly = months.map((m): CashHistoryMonth => {
    const inMonth = (d: string) => d.startsWith(m);
    const n = [...total.keys()].filter(inMonth).length;
    const earned = sumOver(bestDaily, inMonth);
    const actual = sumOver(interestOn, inMonth);
    return {
      month: m,
      days: n,
      average_balance: money(sumOver(total, inMonth).div(n)),
      average_idle: money(sumOver(idle, inMonth).div(n)),
      interest_earned: money(actual),
      would_have_earned: money(earned),
      lost: money(lostAgainst(earned, actual)),
    };
  });

  const accounts = series.map(({ account: a, balances }) => {
    let largest: Big | null = null;
    let checked = 0;
    for (const s of a.snapshots) {
      const rebuilt = s.date >= start ? balances.get(s.date) : undefined;
      if (!rebuilt) continue;
      checked++;
      // Banks often add a transaction to the balance a day after its date (a payroll deposit
      // dated the 30th that lands on the 31st), so a snapshot taken during the day can match
      // the day before instead.
      const before = balances.get(addDays(s.date, -1));
      const sameDay = rebuilt.minus(s.current).abs();
      const dayBefore = before ? before.minus(s.current).abs() : sameDay;
      const diff = sameDay.lt(dayBefore) ? sameDay : dayBefore;
      if (!largest || diff.gt(largest)) largest = diff;
    }
    if (largest?.gt(1)) {
      warnings.push(
        `${a.name}: a balance synced earlier differs from the rebuilt one by ${money(largest)}, ` +
          "so some transactions may be missing; treat its history as approximate.",
      );
    }
    return {
      id: a.id,
      name: a.name,
      institution_name: a.institution_name,
      latest_balance: money(new Big(a.latest_balance)),
      first_transaction: a.first_transaction,
      average_balance: money(sumOver(balances, (d) => d >= start).div(days)),
      interest_earned: money(
        a.interest.reduce((s, i) => (i.date >= start ? s.plus(i.amount) : s), ZERO),
      ),
      check: { snapshots: checked, largest_difference: largest ? money(largest) : null },
    };
  });

  if (from < earliest) {
    warnings.push(`Only the last ${MAX_HISTORY_DAYS} days are counted.`);
  }
  if (days < 90) {
    warnings.push(`Only ${days} days of history so far, so the yearly figure is rough.`);
  }
  const lost = best ? new Big(best.lost) : ZERO;
  return {
    ...empty,
    window: { from: start, to: today, days },
    average_balance: money(sumOver(total).div(days)),
    average_idle: money(sumOver(idle).div(days)),
    interest_earned: money(interestEarned),
    lost: money(lost),
    lost_per_year: money(lost.times(365).div(days)),
    last_365_days: last365,
    best,
    benchmarks,
    monthly,
    accounts,
    warnings,
  };
}

export async function readCashHistoryReport(db: AgentDb, catalog: Catalog, today: string) {
  return cashHistory(await readCashHistory(db, today), catalog);
}

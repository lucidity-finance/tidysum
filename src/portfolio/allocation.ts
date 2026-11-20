import Big from "big.js";
import type { AgentDb } from "../mcp/agentDb.js";
import type { Policy } from "../policy/policy.js";
import { readSnapshot, type Snapshot, type SnapshotHolding } from "../policy/snapshot.js";
import { loadActivePolicy } from "../policy/store.js";
import { investableHoldings, sleevePosition, splitSleeve } from "./investable.js";
import type { Overlap } from "./overlap.js";
import { classMix, type SecurityCatalog, targetDateMix } from "./securityCatalog.js";

export { manualAsHoldings } from "./investable.js";

// How the user's investments are split across the policy's buckets, how far each is from its
// target, and where new money should go to close the gap without selling (the recommendation).
// The moves that would rebalance now by selling are kept for agents to discuss when asked.
// Investment advice, so it only runs for users with investing enabled (decision 0003).
//
// The report is in percentages only: shares of the portfolio, percentage points of drift, and
// the share of a position to sell. No dollar amounts, by design: the owner asked not to see
// them, and percentages are enough to act on in a brokerage.

type Allocation = NonNullable<Policy["allocation"]>;
type Bucket = Allocation["buckets"][string];

/** Plaid investment subtypes where selling realizes no taxable gain. */
const TAX_ADVANTAGED = new Set([
  "401a",
  "401k",
  "403b",
  "457b",
  "529",
  "education savings account",
  "health reimbursement arrangement",
  "hsa",
  "ira",
  "keogh",
  "lira",
  "lrif",
  "lrsp",
  "non-taxable brokerage account",
  "pension",
  "prif",
  "profit sharing plan",
  "qshr",
  "rdsp",
  "resp",
  "retirement",
  "rlif",
  "roth",
  "roth 401k",
  "rrif",
  "rrsp",
  "sarsep",
  "sep ira",
  "simple ira",
  "tfsa",
  "thrift savings plan",
]);

/**
 * Plan names that mark a retirement account whatever subtype the institution reports: a 401(k)
 * recordkeeper may call the plan a "stock plan" or "profit sharing plan".
 */
const RETIREMENT_NAME =
  /\b(401\s*\(?k\)?|403\s*\(?b\)?|457\s*\(?b\)?|ira|roth|retirement|pension|thrift|hsa)\b/i;

export function isTaxAdvantaged(a: {
  subtype: string | null;
  name: string;
  official_name?: string | null;
}): boolean {
  return (
    TAX_ADVANTAGED.has(a.subtype ?? "") ||
    RETIREMENT_NAME.test(a.name) ||
    RETIREMENT_NAME.test(a.official_name ?? "")
  );
}

/** Moves smaller than this many points are rounding noise. */
const MIN_MOVE_POINTS = new Big("0.5");

const ZERO = new Big(0);
const pct = (fraction: Big) => fraction.times(100).toFixed(1);

/** The asset classes a bucket holds: its own list, or the classes in its name. */
export function bucketClasses(name: string, bucket: Bucket): string[] {
  return bucket.asset_classes ?? name.split("_and_");
}

export interface Classified {
  holding: SnapshotHolding;
  /** The share of this holding counted in each bucket. */
  parts: { bucket: string; fraction: Big }[];
  /** The share no bucket covers. */
  unclassified: Big;
  via:
    | "manual"
    | "policy"
    | "catalog"
    | "plan_lineup"
    | "target_date"
    | "cash_equivalent"
    | "security_type"
    | null;
}

/**
 * Puts each holding in buckets. In order: a ticker the policy lists; the catalog's split by asset
 * class (a global fund lands partly in US and partly in international stocks); a workplace-plan
 * fund by its recorded lineup mix; a target-date fund by the year in its name; a cash equivalent; then the Plaid security type a bucket names
 * as a fallback. `year` is the current year, for target-date funds.
 */
export function classifyHoldings(
  allocation: Allocation,
  holdings: SnapshotHolding[],
  catalog?: SecurityCatalog,
  year: number = new Date().getUTCFullYear(),
): Classified[] {
  const buckets = Object.entries(allocation.buckets);
  const byTicker = new Map(catalog?.securities.map((s) => [s.ticker, s]) ?? []);
  const cashBucket =
    buckets.find(([, b]) => b.cash_equivalents)?.[0] ??
    buckets.find(([name, b]) => bucketClasses(name, b).includes("cash"))?.[0];
  const bucketFor = (cls: string) =>
    buckets.find(([name, b]) => bucketClasses(name, b).includes(cls))?.[0] ??
    (cls === "cash" ? cashBucket : undefined);

  return holdings.map((h): Classified => {
    const ticker = h.ticker_symbol?.toUpperCase();
    const whole = (bucket: string, via: Classified["via"]): Classified => ({
      holding: h,
      parts: [{ bucket, fraction: new Big(1) }],
      unclassified: ZERO,
      via,
    });
    const split = (mix: Record<string, Big.BigSource>, via: Classified["via"]): Classified => {
      const parts = new Map<string, Big>();
      let unclassified = ZERO;
      for (const [cls, share] of Object.entries(mix)) {
        const bucket = bucketFor(cls);
        if (bucket) parts.set(bucket, (parts.get(bucket) ?? ZERO).plus(share));
        else unclassified = unclassified.plus(share);
      }
      return {
        holding: h,
        parts: [...parts].map(([bucket, fraction]) => ({ bucket, fraction })),
        unclassified,
        via,
      };
    };
    if (h.asset_class) return split({ [h.asset_class]: 1 }, "manual");
    const listed = buckets.find(
      ([, b]) => ticker && b.tickers.some((t) => t.toUpperCase() === ticker),
    );
    if (listed) return whole(listed[0], "policy");
    const known = ticker ? byTicker.get(ticker) : undefined;
    if (known) return split(classMix(known.mix), "catalog");
    if (h.plan_mix) return split(classMix(h.plan_mix), "plan_lineup");
    const dated = targetDateMix(catalog, h.security_name, year);
    if (dated) return split(dated, "target_date");
    if ((h.is_cash_equivalent || h.security_type === "cash") && cashBucket) {
      return whole(cashBucket, "cash_equivalent");
    }
    const typed = buckets.find(
      ([, b]) => h.security_type && (b.security_types as string[]).includes(h.security_type),
    );
    if (typed) return whole(typed[0], "security_type");
    return { holding: h, parts: [], unclassified: new Big(1), via: null };
  });
}

export interface AllocationBucket {
  key: string;
  label: string;
  /** The asset classes it holds, from catalog/securities.json. */
  classes: string[];
  /** Percent of the classified portfolio, like "41.2". */
  current: string;
  target: string;
  /** Percentage points off target; negative is under. */
  drift: string;
  status: "ok" | "over" | "under";
  /** The biggest holdings counted here, with the percent of the portfolio each adds. */
  holdings: { ticker: string | null; name: string | null; percent: string }[];
}

export interface Sell {
  ticker: string | null;
  name: string | null;
  account_id: string;
  account_name: string;
  tax_advantaged: boolean;
  /** Share of this position to sell, like "35". */
  percent_of_position: string;
  /** Gain or loss on the position in percent of cost, when the brokerage reports cost basis. */
  gain: string | null;
}

export interface Move {
  from: string;
  to: string;
  /** Percentage points of the portfolio to move. */
  points: string;
  sell: Sell[];
  /** Points of the move no single-bucket position covers; sell from other holdings. */
  uncovered: string;
  buy: { ticker: string; name: string | null; held: boolean } | null;
}

/**
 * Where new money (paychecks) should go so the mix moves toward the target without selling
 * anything. While some buckets are under target, contributions go only to them, split so they
 * all reach their targets together; after that, contributions follow the targets.
 */
export interface NewMoney {
  basis: "catch_up" | "target";
  /**
   * How much new money closing the gap takes, as a percent of today's portfolio, like "39".
   * Null when it can't be closed by contributions alone or there is no gap.
   */
  catch_up: string | null;
  /** Whole percents of each contribution, adding up to 100. */
  split: { bucket: string; percent: string; buy: Move["buy"] }[];
  /** The policy's cap on one bucket's share of a contribution, like "0.6", when it has one. */
  max_share?: string;
}

/** Whole percents that add up to 100, by largest remainder. */
function wholePercents(shares: Big[]): number[] {
  const total = shares.reduce((s, x) => s.plus(x), ZERO);
  if (total.lte(0)) return shares.map(() => 0);
  const raw = shares.map((x) => x.div(total).times(100));
  const floors = raw.map((x) => Number(x.round(0, Big.roundDown)));
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((x, i) => ({ i, rem: x.minus(floors[i] ?? 0) }))
    .sort((a, b) => b.rem.cmp(a.rem));
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    left--;
  }
  return floors;
}

/**
 * Caps each bucket's share of a contribution at `cap`, handing the excess to the buckets below
 * the cap in proportion to their targets, so no single bucket takes all of every paycheck.
 */
export function capShares(
  rows: { key: string; share: Big }[],
  targets: { key: string; target: Big }[],
  cap: Big,
): { key: string; share: Big }[] {
  const total = rows.reduce((s, r) => s.plus(r.share), ZERO);
  if (total.lte(0)) return rows;
  const share = new Map(targets.map((t) => [t.key, ZERO]));
  for (const r of rows) share.set(r.key, r.share.div(total));
  const capped = new Set<string>();
  for (let i = 0; i < targets.length; i++) {
    let excess = ZERO;
    for (const [key, s] of share) {
      if (s.gt(cap)) {
        excess = excess.plus(s.minus(cap));
        share.set(key, cap);
        capped.add(key);
      }
    }
    if (excess.lte(0)) break;
    const takers = targets.filter((t) => !capped.has(t.key) && t.target.gt(0));
    const weight = takers.reduce((s, t) => s.plus(t.target), ZERO);
    if (weight.lte(0)) break;
    for (const t of takers) {
      share.set(t.key, (share.get(t.key) ?? ZERO).plus(excess.times(t.target).div(weight)));
    }
  }
  return targets.map((t) => ({ key: t.key, share: share.get(t.key) ?? ZERO }));
}

export function newMoneySplit(
  weights: { key: string; target: Big; weight: Big }[],
  buyFor: (key: string) => Move["buy"],
  /** The most of each contribution one bucket may take, like 0.6; none means no cap. */
  maxShare?: Big,
): NewMoney {
  const result = newMoneyUncapped(weights, buyFor, maxShare);
  return maxShare ? { ...result, max_share: maxShare.toString() } : result;
}

function newMoneyUncapped(
  weights: { key: string; target: Big; weight: Big }[],
  buyFor: (key: string) => Move["buy"],
  maxShare?: Big,
): NewMoney {
  const minGap = MIN_MOVE_POINTS.div(100);
  const under = weights.filter((w) => w.target.minus(w.weight).gte(minGap));
  // The cap is for catching up; once on target, contributions simply follow the targets.
  const shape = (uncapped: { key: string; share: Big }[], capped = true) => {
    const rows = maxShare && capped ? capShares(uncapped, weights, maxShare) : uncapped;
    const kept = rows.filter((r) => r.share.gt(0));
    const whole = wholePercents(kept.map((r) => r.share));
    return kept
      .map((r, i) => ({ bucket: r.key, percent: String(whole[i] ?? 0), buy: buyFor(r.key) }))
      .filter((r) => r.percent !== "0");
  };
  if (under.length === 0) {
    return {
      basis: "target",
      catch_up: null,
      split: shape(
        weights.map((w) => ({ key: w.key, share: w.target })),
        false,
      ),
    };
  }
  const targets = under.reduce((s, w) => s.plus(w.target), ZERO);
  const gap = under.reduce((s, w) => s.plus(w.target.minus(w.weight)), ZERO);
  if (targets.gte(1)) {
    // Every bucket that holds anything is meant to hold nothing: only selling closes the gap.
    return {
      basis: "catch_up",
      catch_up: null,
      split: shape(under.map((w) => ({ key: w.key, share: w.target.minus(w.weight) }))),
    };
  }
  // New money n (a share of today's portfolio) brings each underweight bucket to its target
  // when t(1 + n) - w goes to it, which sums to n when n = gap / (1 - their targets).
  const n = gap.div(new Big(1).minus(targets));
  return {
    basis: "catch_up",
    catch_up: n.times(100).toFixed(0),
    split: shape(
      under.map((w) => ({ key: w.key, share: w.target.times(n.plus(1)).minus(w.weight) })),
    ),
  };
}

export interface SleeveSummary {
  /** Percent of investable assets, like "5.0". */
  cap: string;
  current: string;
  /** Points left under the cap; "0.0" when at or over it. */
  room: string;
  over: boolean;
  /** What the sleeve holds, with the percent of investable assets each is. */
  holdings: { ticker: string | null; name: string | null; percent: string }[];
}

export function sleeveSummary(policy: Policy, snapshot: Snapshot): SleeveSummary | null {
  const p = sleevePosition(policy, snapshot);
  if (!p) return null;
  const room = p.cap.minus(p.share);
  return {
    cap: pct(p.cap),
    current: pct(p.share),
    room: pct(room.gt(0) ? room : ZERO),
    over: p.share.gt(p.cap),
    holdings: p.investable.gt(0)
      ? topBySecurity(
          p.holdings.map((h) => ({ h, value: new Big(h.institution_value) })),
          p.investable,
          20,
        )
      : [],
  };
}

export interface AllocationReport {
  as_of: string;
  drift_band: string;
  /** Whether any bucket is outside the drift band. */
  rebalance: boolean;
  buckets: AllocationBucket[];
  /** What to do with new money: the recommendation, since it needs no selling. */
  new_money: NewMoney;
  /** Selling to rebalance now, for when the owner asks; the page doesn't offer it. */
  moves: Move[];
  /** Percent of holdings no bucket covers; they're left out of the percentages above. */
  unclassified: {
    percent: string;
    holdings: { ticker: string | null; name: string | null; percent: string }[];
  };
  /** Positions left out because they are another account counted a second time. */
  counted_once: Overlap[];
  /**
   * The research sleeve against its cap, in percent of investable assets; null when the policy
   * has none. Its positions are left out of the buckets above.
   */
  sleeve: SleeveSummary | null;
  concentration: {
    /** Percent of all holdings in individual stocks. */
    single_stocks: string;
    largest: { ticker: string | null; name: string | null; percent: string }[];
  };
  notes: string[];
}

const labelOf = (key: string, catalog?: SecurityCatalog) =>
  catalog?.classes[key] ??
  key
    .split("_")
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ")
    .replace(/\bintl\b/, "international")
    .replace(/\bus\b/i, "US");

/** Groups positions by security across accounts, for "what's in here" lists. */
function topBySecurity(
  rows: { h: SnapshotHolding; value: Big }[],
  total: Big,
  limit: number,
): { ticker: string | null; name: string | null; percent: string }[] {
  const groups = new Map<string, { h: SnapshotHolding; value: Big }>();
  for (const r of rows) {
    const id = r.h.ticker_symbol ?? r.h.security_id ?? r.h.security_name ?? "";
    const g = groups.get(id);
    groups.set(id, { h: r.h, value: (g?.value ?? ZERO).plus(r.value) });
  }
  return [...groups.values()]
    .sort((a, b) => b.value.cmp(a.value))
    .slice(0, limit)
    .map((g) => ({
      ticker: g.h.ticker_symbol,
      name: g.h.security_name,
      percent: pct(g.value.div(total)),
    }));
}

type Empty = "no_target" | "no_holdings" | "nothing_classified";

export function buildAllocationReport(
  policy: Policy,
  snapshot: Snapshot,
  catalog?: SecurityCatalog,
): AllocationReport | { as_of: string; empty: Empty } {
  const allocation = policy.allocation;
  if (!allocation) return { as_of: snapshot.today, empty: "no_target" };
  const accounts = new Map(snapshot.accounts.map((a) => [a.id, a]));
  const investable = investableHoldings(policy, snapshot);
  const counted = { overlaps: investable.overlaps };
  const all = investable.holdings.filter((h) => new Big(h.institution_value).gt(0));
  const grand = all.reduce((s, h) => s.plus(h.institution_value), ZERO);
  if (grand.lte(0)) return { as_of: snapshot.today, empty: "no_holdings" };
  // Research-sleeve positions count toward the sleeve's cap, not toward any bucket.
  const holdings = splitSleeve(policy, all).core;

  const classified = classifyHoldings(
    allocation,
    holdings,
    catalog,
    Number(snapshot.today.slice(0, 4)),
  );
  const values = new Map(Object.keys(allocation.buckets).map((k) => [k, ZERO]));
  const inBucket = new Map<string, { h: SnapshotHolding; value: Big }[]>();
  const loose: { h: SnapshotHolding; value: Big }[] = [];
  for (const c of classified) {
    const value = new Big(c.holding.institution_value);
    for (const p of c.parts) {
      const v = value.times(p.fraction);
      values.set(p.bucket, (values.get(p.bucket) ?? ZERO).plus(v));
      inBucket.set(p.bucket, [...(inBucket.get(p.bucket) ?? []), { h: c.holding, value: v }]);
    }
    if (c.unclassified.gt(0)) loose.push({ h: c.holding, value: value.times(c.unclassified) });
  }
  const unclassifiedValue = loose.reduce((s, r) => s.plus(r.value), ZERO);
  const sleeveValue = grand.minus(holdings.reduce((s, h) => s.plus(h.institution_value), ZERO));
  const total = grand.minus(unclassifiedValue).minus(sleeveValue);
  const notes: string[] = [];
  if (total.lte(0)) return { as_of: snapshot.today, empty: "nothing_classified" };

  const band = new Big(allocation.drift_band);
  const weights = Object.entries(allocation.buckets).map(([key, b]) => {
    const weight = (values.get(key) ?? ZERO).div(total);
    return { key, b, weight, drift: weight.minus(b.target) };
  });
  const rebalance = weights.some((w) => w.drift.abs().gt(band));
  const buckets: AllocationBucket[] = weights.map((w) => ({
    key: w.key,
    label: labelOf(w.key, catalog),
    classes: bucketClasses(w.key, w.b),
    current: pct(w.weight),
    target: pct(new Big(w.b.target)),
    drift: pct(w.drift),
    status: w.drift.abs().lte(band) ? "ok" : w.drift.gt(0) ? "over" : "under",
    holdings: topBySecurity(inBucket.get(w.key) ?? [], total, 8),
  }));

  // Positions wholly in one bucket can be sold to fix it. Tax-advantaged accounts first (no tax
  // on the sale), then losses before gains, smallest gain first.
  const gainOf = (h: SnapshotHolding) =>
    h.cost_basis && new Big(h.cost_basis).gt(0)
      ? new Big(h.institution_value).div(h.cost_basis).minus(1)
      : null;
  const lots = new Map<string, { c: Classified; points: Big; left: Big }[]>();
  for (const c of classified) {
    const [only] = c.parts;
    if (c.parts.length !== 1 || !only || !only.fraction.eq(1)) continue;
    const share = new Big(c.holding.institution_value).div(total);
    lots.set(only.bucket, [...(lots.get(only.bucket) ?? []), { c, points: share, left: share }]);
  }
  const advantaged = (id: string) => {
    const a = accounts.get(id);
    return !!a && isTaxAdvantaged(a);
  };
  for (const list of lots.values()) {
    list.sort((x, y) => {
      const a = x.c.holding;
      const b = y.c.holding;
      const t = Number(advantaged(b.account_id)) - Number(advantaged(a.account_id));
      if (t !== 0) return t;
      const ga = gainOf(a);
      const gb = gainOf(b);
      if (ga && gb && !ga.eq(gb)) return ga.cmp(gb);
      if (ga && !gb) return -1;
      if (gb && !ga) return 1;
      return y.points.cmp(x.points);
    });
  }

  const held = new Set(
    all.map((h) => h.ticker_symbol?.toUpperCase()).filter((t): t is string => !!t),
  );
  const buyFor = (key: string): Move["buy"] => {
    const b = allocation.buckets[key];
    if (!b) return null;
    const listed = b.tickers.map((t) => t.toUpperCase());
    const fallback = bucketClasses(key, b)
      .map(
        (cls) =>
          catalog?.default_buy_by_country[snapshot.country ?? "US"]?.[cls] ??
          catalog?.default_buy[cls],
      )
      .find((t): t is string => !!t);
    const ticker = listed.find((t) => held.has(t)) ?? listed[0] ?? fallback;
    if (!ticker) return null;
    const name =
      catalog?.securities.find((s) => s.ticker === ticker)?.name ??
      holdings.find((h) => h.ticker_symbol?.toUpperCase() === ticker)?.security_name ??
      null;
    return { ticker, name, held: held.has(ticker) };
  };

  // Buckets kept out of taxable accounts get no new money; their share stays with the accounts
  // that hold them, and the other buckets split each contribution.
  const newMoney = newMoneySplit(
    weights
      .filter((w) => w.b.taxable_new_money)
      .map((w) => ({ key: w.key, target: new Big(w.b.target), weight: w.weight })),
    buyFor,
    allocation.new_money_max_share ? new Big(allocation.new_money_max_share) : undefined,
  );

  const moves: Move[] = [];
  if (rebalance) {
    const over = weights.filter((w) => w.drift.gt(0)).map((w) => ({ key: w.key, left: w.drift }));
    const under = weights
      .filter((w) => w.drift.lt(0))
      .map((w) => ({ key: w.key, left: w.drift.abs() }));
    over.sort((a, b) => b.left.cmp(a.left));
    under.sort((a, b) => b.left.cmp(a.left));
    let i = 0;
    let j = 0;
    while (i < over.length && j < under.length) {
      const o = over[i];
      const u = under[j];
      if (!o || !u) break;
      const amount = o.left.lt(u.left) ? o.left : u.left;
      o.left = o.left.minus(amount);
      u.left = u.left.minus(amount);
      if (amount.times(100).gte(MIN_MOVE_POINTS)) {
        const sell: Sell[] = [];
        let need = amount;
        for (const lot of lots.get(o.key) ?? []) {
          if (need.lte(0)) break;
          if (lot.left.lte(0)) continue;
          const take = lot.left.lt(need) ? lot.left : need;
          lot.left = lot.left.minus(take);
          need = need.minus(take);
          const h = lot.c.holding;
          const gain = gainOf(h);
          sell.push({
            ticker: h.ticker_symbol,
            name: h.security_name,
            account_id: h.account_id,
            account_name: accounts.get(h.account_id)?.name ?? "",
            tax_advantaged: advantaged(h.account_id),
            percent_of_position: take.div(lot.points).times(100).toFixed(0),
            gain: gain ? gain.times(100).toFixed(0) : null,
          });
        }
        moves.push({
          from: o.key,
          to: u.key,
          points: pct(amount),
          sell,
          uncovered: pct(need),
          buy: buyFor(u.key),
        });
      }
      if (o.left.lte(0)) i++;
      if (u.left.lte(0)) j++;
    }
    const sells = moves.flatMap((m) => m.sell);
    if (sells.some((s) => !s.tax_advantaged && s.gain !== null && new Big(s.gain).gt(0))) {
      notes.push(
        "Selling at a gain in a taxable account is taxed. Putting new money into the underweight buckets instead avoids that.",
      );
    }
  }

  if (unclassifiedValue.gt(0)) {
    notes.push(
      "Some holdings match no bucket, so they're left out of the percentages. Add their tickers to the policy or the security catalog.",
    );
  }
  const stocks = all
    .filter((h) => h.security_type === "equity")
    .reduce((s, h) => s.plus(h.institution_value), ZERO);

  return {
    as_of: snapshot.today,
    drift_band: pct(band),
    rebalance,
    buckets,
    new_money: newMoney,
    moves,
    unclassified: {
      percent: pct(unclassifiedValue.div(grand)),
      holdings: topBySecurity(loose, grand, 20),
    },
    counted_once: counted.overlaps,
    sleeve: sleeveSummary(policy, snapshot),
    concentration: {
      single_stocks: pct(stocks.div(grand)),
      largest: topBySecurity(
        all.map((h) => ({ h, value: new Big(h.institution_value) })),
        grand,
        5,
      ),
    },
    notes,
  };
}

export type AllocationResult =
  | (AllocationReport & { state: "ready" })
  | { state: "off" | "no_policy" | Empty; as_of: string };

/** The session user's allocation, read through row-level security. */
export async function readAllocation(
  db: AgentDb,
  catalog: SecurityCatalog | undefined,
  today: string,
): Promise<AllocationResult> {
  const snapshot = await readSnapshot(db, today);
  if (!snapshot.investing_enabled) return { state: "off", as_of: today };
  const { rows } = await db.query("select 1 from policy_version limit 1");
  if (rows.length === 0) return { state: "no_policy", as_of: today };
  const { policy } = await loadActivePolicy(db);
  const report = buildAllocationReport(policy, snapshot, catalog);
  if ("empty" in report) return { state: report.empty, as_of: today };
  return { state: "ready", ...report };
}

/**
 * What the admin page shows: buckets and moves between them, nothing about single positions.
 * The owner doesn't want to see which stocks he holds or how much each is up or down, so the
 * page gets no tickers, names, per-position shares or gains. Agents still get the full report.
 */
export function allocationForPage(r: AllocationResult) {
  if (r.state !== "ready") return r;
  return {
    state: r.state,
    as_of: r.as_of,
    drift_band: r.drift_band,
    rebalance: r.rebalance,
    buckets: r.buckets.map(({ holdings: _, ...b }) => b),
    new_money: r.new_money,
    unclassified: { percent: r.unclassified.percent },
    counted_once: r.counted_once.map((o) => ({
      account: o.same_as_account_name,
      institution: o.same_as_institution_name,
      inside: o.account_name,
      inside_institution: o.institution_name,
    })),
    concentration: { single_stocks: r.concentration.single_stocks },
    sleeve: r.sleeve && {
      cap: r.sleeve.cap,
      current: r.sleeve.current,
      room: r.sleeve.room,
      over: r.sleeve.over,
    },
  };
}

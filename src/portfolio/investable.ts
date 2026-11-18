import Big from "big.js";
import type { Policy } from "../policy/policy.js";
import type { Snapshot, SnapshotHolding } from "../policy/snapshot.js";
import { countOnce, type Overlap } from "./overlap.js";

// What counts as the owner's investable assets, and which part of it is the research sleeve.
// The allocation report, the policy checks and proposal validation all start here, so they
// agree on the same numbers.

/** Holdings entered by hand, as holdings in their own pseudo-accounts. */
export function manualAsHoldings(snapshot: Snapshot): SnapshotHolding[] {
  return (snapshot.manual_holdings ?? []).map((m) => ({
    account_id: `manual:${m.id}`,
    security_id: `manual:${m.id}`,
    ticker_symbol: null,
    security_name: m.name,
    is_cash_equivalent: m.asset_class === "cash",
    security_type: "manual",
    institution_value: m.value,
    asset_class: m.asset_class,
  }));
}

/**
 * Every position in the allocation's accounts (all investment accounts by default), each counted
 * once, plus holdings entered by hand.
 */
export function investableHoldings(
  policy: Policy,
  snapshot: Snapshot,
): { accountIds: Set<string>; holdings: SnapshotHolding[]; overlaps: Overlap[] } {
  const accountIds = new Set(
    policy.allocation?.account_ids ??
      snapshot.accounts.filter((a) => a.type === "investment").map((a) => a.id),
  );
  // A 401(k)'s brokerage window shows up as a lump there and again as its own account.
  const counted = countOnce(
    snapshot.accounts.filter((a) => accountIds.has(a.id)),
    snapshot.holdings.filter((h) => accountIds.has(h.account_id)),
  );
  return {
    accountIds,
    holdings: [...counted.holdings, ...manualAsHoldings(snapshot)],
    overlaps: counted.overlaps,
  };
}

/** Tickers the policy names as research-sleeve positions, upper case. */
export function sleeveTickers(policy: Policy): Set<string> {
  return new Set((policy.research_sleeve?.tickers ?? []).map((t) => t.toUpperCase()));
}

/** Splits holdings into the core (what the buckets measure) and the research sleeve. */
export function splitSleeve(
  policy: Policy,
  holdings: SnapshotHolding[],
): { core: SnapshotHolding[]; sleeve: SnapshotHolding[] } {
  const tickers = sleeveTickers(policy);
  const core: SnapshotHolding[] = [];
  const sleeve: SnapshotHolding[] = [];
  for (const h of holdings) {
    const t = h.ticker_symbol?.toUpperCase();
    (t && tickers.has(t) ? sleeve : core).push(h);
  }
  return { core, sleeve };
}

const ZERO = new Big(0);
const positive = (h: SnapshotHolding) => new Big(h.institution_value).gt(0);

export interface SleevePosition {
  /** The cap as a fraction of investable assets. */
  cap: Big;
  /** Everything investable, sleeve included. */
  investable: Big;
  /** What the sleeve holds now. */
  value: Big;
  /** value / investable; zero when nothing is invested. */
  share: Big;
  holdings: SnapshotHolding[];
}

/** Where the sleeve stands against its cap; null when the policy has no research sleeve. */
export function sleevePosition(policy: Policy, snapshot: Snapshot): SleevePosition | null {
  const rule = policy.research_sleeve;
  if (!rule) return null;
  const all = investableHoldings(policy, snapshot).holdings.filter(positive);
  const { sleeve } = splitSleeve(policy, all);
  const investable = all.reduce((s, h) => s.plus(h.institution_value), ZERO);
  const value = sleeve.reduce((s, h) => s.plus(h.institution_value), ZERO);
  return {
    cap: new Big(rule.cap),
    investable,
    value,
    share: investable.gt(0) ? value.div(investable) : ZERO,
    holdings: sleeve,
  };
}

/**
 * How much new money may still go into the sleeve. Buying B with money from outside the
 * investments grows both sides, so the cap holds while S + B <= cap * (I + B), that is
 * B <= (cap * I - S) / (1 - cap). Zero when the sleeve is at or over its cap.
 */
export function sleeveRoom(p: SleevePosition): Big {
  if (p.cap.gte(1)) return p.investable;
  const room = p.cap.times(p.investable).minus(p.value).div(new Big(1).minus(p.cap));
  return room.gt(0) ? room : ZERO;
}

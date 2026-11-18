import Big from "big.js";
import type { SnapshotAccount, SnapshotHolding } from "../policy/snapshot.js";

// The same money can arrive twice. A 401(k) with a brokerage window (Schwab PCRA, Fidelity
// BrokerageLink, a "self-directed brokerage account") reports the window as one lump position,
// and the brokerage holding the window reports it again as its own account with the real funds.
// Counting both inflates the portfolio and puts the lump in whatever bucket its security type
// suggests. Each lump that matches a whole other account is left out, and the other account's
// own positions are counted instead, since they say what the money is invested in.

/** Words recordkeepers and brokerages use for a brokerage window. */
export const WINDOW =
  /brokerage|self[\s-]*directed|\bsdba\b|\bpcra\b|personal choice|brokeragelink|mutual fund window/i;

/**
 * How far apart the lump and the account may be. They're usually priced on different days, so
 * an exact match is too strict; a matching name is also required, so a loose band is safe.
 */
const TOLERANCE = new Big("0.03");

export interface Overlap {
  /** The account with the lump position, like the 401(k). */
  account_id: string;
  account_name: string;
  institution_name: string | null;
  security_id: string | null;
  security_name: string | null;
  /** The account that lump is: its own positions are counted instead. */
  same_as_account_id: string;
  same_as_account_name: string;
  same_as_institution_name: string | null;
}

function accountValue(a: SnapshotAccount, holdings: SnapshotHolding[]): Big | null {
  const own = holdings.filter((h) => h.account_id === a.id);
  if (own.length > 0) return own.reduce((s, h) => s.plus(h.institution_value), new Big(0));
  return a.current === null ? null : new Big(a.current);
}

const label = (a: SnapshotAccount) => [a.name, a.official_name ?? ""].join(" ");

/**
 * Lump positions that are another investment account counted a second time. Each lump and
 * each account is matched at most once, closest value first.
 */
export function findOverlaps(accounts: SnapshotAccount[], holdings: SnapshotHolding[]): Overlap[] {
  const investment = accounts.filter((a) => a.type === "investment");
  const values = new Map(investment.map((a) => [a.id, accountValue(a, holdings)]));
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const candidates: { h: SnapshotHolding; other: SnapshotAccount; off: Big }[] = [];
  for (const h of holdings) {
    const value = new Big(h.institution_value);
    if (value.lte(0)) continue;
    const holder = byId.get(h.account_id);
    if (!holder) continue;
    const named = WINDOW.test(h.security_name ?? "");
    for (const other of investment) {
      if (other.id === h.account_id) continue;
      const otherValue = values.get(other.id);
      if (!otherValue || otherValue.lte(0)) continue;
      if (!named && !(h.ticker_symbol === null && WINDOW.test(label(other)))) continue;
      const off = value.div(otherValue).minus(1).abs();
      if (off.lte(TOLERANCE)) candidates.push({ h, other, off });
    }
  }
  candidates.sort((a, b) => a.off.cmp(b.off));
  const usedHoldings = new Set<SnapshotHolding>();
  const usedAccounts = new Set<string>();
  const overlaps: Overlap[] = [];
  for (const { h, other } of candidates) {
    if (usedHoldings.has(h) || usedAccounts.has(other.id)) continue;
    // A lump can't stand for the account it sits in, nor for one that is itself a lump's home.
    if (usedAccounts.has(h.account_id)) continue;
    usedHoldings.add(h);
    usedAccounts.add(other.id);
    overlaps.push({
      account_id: h.account_id,
      account_name: byId.get(h.account_id)?.name ?? "",
      institution_name: byId.get(h.account_id)?.institution_name ?? null,
      security_id: h.security_id ?? null,
      security_name: h.security_name,
      same_as_account_id: other.id,
      same_as_account_name: other.name,
      same_as_institution_name: other.institution_name ?? null,
    });
  }
  return overlaps;
}

/** Holdings with each double-counted lump left out, and the overlaps that were found. */
export function countOnce(
  accounts: SnapshotAccount[],
  holdings: SnapshotHolding[],
): { holdings: SnapshotHolding[]; overlaps: Overlap[] } {
  const overlaps = findOverlaps(accounts, holdings);
  if (overlaps.length === 0) return { holdings, overlaps };
  const lumps = new Set(overlaps.map((o) => `${o.account_id}\u0000${o.security_id}`));
  return {
    holdings: holdings.filter((h) => !lumps.has(`${h.account_id}\u0000${h.security_id ?? null}`)),
    overlaps,
  };
}

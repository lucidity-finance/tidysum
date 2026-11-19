import Big from "big.js";

// Some brokerages add a match to IRA contributions, paid by the brokerage itself (not a referral
// fee: it goes into the owner's own IRA, so it can be priced like any other money the owner
// would otherwise miss). In a backdoor Roth the match lands in the traditional IRA as earnings,
// so converting it with the contribution is taxed; a straight Roth contribution's match isn't.
// Terms change without notice: check `verified_on` and the source before relying on them.

export interface IraMatchOffer {
  id: string;
  provider: string;
  /** Lowercased institution names the data source reports for this brokerage. */
  institutions: string[];
  /** Match on contributions for everyone, as a fraction. */
  base_rate: string;
  /** A paid membership that raises the match. */
  membership?: {
    name: string;
    rate: string;
    monthly_fee: string;
    /** A yearly price, when the membership can be paid by the year. */
    annual_fee?: string;
    /** Months the membership must be kept after the first boosted match, or part of it is charged back. */
    keep_months: number;
  };
  /** Matched money taken out of the brokerage within this many years is charged the match back. */
  hold_years: number;
  /** About how long after a contribution settles the match arrives. */
  credited_within_days: number;
  /** Only contributions from a linked outside bank account are matched. */
  bank_funded_only: boolean;
  source_url: string;
  verified_on: string;
}

export const IRA_MATCH_OFFERS: IraMatchOffer[] = [
  {
    id: "robinhood",
    provider: "Robinhood",
    institutions: ["robinhood"],
    base_rate: "0.01",
    membership: {
      name: "Robinhood Gold",
      rate: "0.03",
      monthly_fee: "5",
      annual_fee: "50",
      keep_months: 12,
    },
    hold_years: 5,
    credited_within_days: 7,
    bank_funded_only: true,
    // Match terms; Gold's price ("$5/mo or $50/yr") is on robinhood.com/us/en/support/articles/robinhood-gold-card-waitlist/
    source_url: "https://cdn.robinhood.com/assets/robinhood/legal/Gold%20IRA%20Match%20T&Cs.pdf",
    verified_on: "2026-11-19",
  },
];

export interface IraMatch {
  offer: string;
  provider: string;
  /** The membership to hold for the boosted rate, or null for the base rate. */
  membership: string | null;
  rate: string;
  /** The match on this contribution. */
  amount: string;
  /** Tax on the match when it's converted to Roth (backdoor only). */
  conversion_tax: string;
  /** What the membership costs over the months it must be kept. */
  membership_fee: string;
  /** The owner already has the membership, so its fee isn't counted and nothing needs turning on. */
  membership_held: boolean;
  membership_monthly_fee: string | null;
  membership_annual_fee: string | null;
  membership_keep_months: number | null;
  /** Match less its tax and the membership: what doing the contribution here adds. */
  net: string;
  hold_years: number;
  credited_within_days: number;
  bank_funded_only: boolean;
  source_url: string;
  verified_on: string;
}

const money = (b: Big) => b.toFixed(2);

export function offerAt(institution: string | null | undefined): IraMatchOffer | undefined {
  const name = institution?.toLowerCase().trim();
  if (!name) return undefined;
  return IRA_MATCH_OFFERS.find((o) => o.institutions.some((i) => name.includes(i)));
}

/**
 * The better of an offer's two rates for one contribution: the base match, or the membership's
 * higher match less what the membership costs over the months it must be kept. Null when the
 * brokerage has no match or it doesn't come to a dollar.
 */
export function bestMatch(
  offer: IraMatchOffer | undefined,
  contribution: Big,
  /** Tax on the match: the marginal rate for a backdoor Roth's conversion, 0 for a Roth contribution. */
  taxRate: Big,
  /** Memberships the owner already pays for anyway: they cost the contribution nothing. */
  held: string[] = [],
): IraMatch | null {
  if (!offer || contribution.lte(0)) return null;
  const option = (rate: string, fee: Big, m: IraMatchOffer["membership"] | null) => {
    const amount = contribution.times(rate).round(2, Big.roundDown);
    const tax = amount.times(taxRate);
    return {
      membership: m?.name ?? null,
      rate,
      amount,
      tax,
      fee,
      net: amount.minus(tax).minus(fee),
      monthly: m?.monthly_fee ?? null,
      annual: m?.annual_fee ?? null,
      keep: m?.keep_months ?? null,
    };
  };
  const base = option(offer.base_rate, new Big(0), null);
  const m = offer.membership;
  // The months it must be kept, paid monthly or, where cheaper, by the year.
  const keepCost = (x: NonNullable<IraMatchOffer["membership"]>) => {
    const monthly = new Big(x.monthly_fee).times(x.keep_months);
    if (!x.annual_fee) return monthly;
    const yearly = new Big(x.annual_fee).times(Math.ceil(x.keep_months / 12));
    return yearly.lt(monthly) ? yearly : monthly;
  };
  const alreadyHeld = !!m && held.some((h) => h.toLowerCase() === m.name.toLowerCase());
  const boosted = m ? option(m.rate, alreadyHeld ? new Big(0) : keepCost(m), m) : null;
  const pick = boosted?.net.gt(base.net) ? boosted : base;
  if (pick.net.lt(1)) return null;
  return {
    offer: offer.id,
    provider: offer.provider,
    membership: pick.membership,
    rate: pick.rate,
    amount: money(pick.amount),
    conversion_tax: money(pick.tax),
    membership_fee: money(pick.fee),
    membership_held: !!pick.membership && alreadyHeld,
    membership_monthly_fee: pick.monthly,
    membership_annual_fee: pick.annual,
    membership_keep_months: pick.keep,
    net: money(pick.net),
    hold_years: offer.hold_years,
    credited_within_days: offer.credited_within_days,
    bank_funded_only: offer.bank_funded_only,
    source_url: offer.source_url,
    verified_on: offer.verified_on,
  };
}

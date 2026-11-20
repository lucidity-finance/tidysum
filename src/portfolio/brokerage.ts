import Big from "big.js";
import type { Detector, Misallocation } from "../misallocation/detect.js";
import type { Policy } from "../policy/policy.js";
import type { Snapshot, SnapshotAccount, SnapshotHolding } from "../policy/snapshot.js";
import { atInstitution } from "../products/catalog.js";
import { fundMarket, type Region } from "../region.js";
import { buildAllocationReport, isTaxAdvantaged } from "./allocation.js";
import { findOverlaps } from "./overlap.js";
import {
  type CatalogSecurity,
  listedIn,
  type SecurityCatalog,
  sleeveLabel,
} from "./securityCatalog.js";

// Investments outside a workplace plan, priced (decision 0003). Three detectors, all investment
// advice, so they run only for users with investing enabled:
//
// - holding_fee: a fund in a brokerage or IRA that costs more than another fund holding the same
//   thing (the same index, by the catalog's `tracks`), listed where the owner lives. A swap is
//   faithful or it isn't made (decision 0007): a fund nothing else copies is left alone, however
//   dear. In a taxable account a swap that sells at a gain owes tax, so it is only suggested when
//   the lower fee pays that tax back quickly; otherwise new money goes to the cheaper fund instead.
// - brokerage_cash: cash sitting uninvested in a brokerage, priced as what a Treasury bill fund
//   would pay over what the brokerage pays on it. Money market funds a brokerage uses as its cash
//   (VMFXX, SPAXX) are funds, not idle cash, and aren't flagged.
// - allocation_drift: a mix outside its drift band, priced as the risk the owner didn't choose:
//   with the target taken as the owner's best mix, a drift d costs ½·γ·dᵀΣd a year in
//   risk-adjusted return, Σ from published long-run volatilities and correlations and γ how much
//   return the owner's own target asks per unit of risk. No forecast of one class beating another,
//   and the fix is new money toward the target, never selling.
//
// Workplace plans and their brokerage windows are priced by fund_fee and brokerage_window
// (src/retirement/workplace.ts), so their accounts are left out here.

/** The longest a fee saving may take to pay back the tax on selling at a gain. */
export const MAX_PAYBACK_YEARS = 2;

/**
 * US federal long-term capital gains rate assumed for selling at a gain: the rate most investors
 * pay. States without an income tax add nothing; a higher earner pays more,
 * which only makes a swap pay back later.
 */
export const US_GAINS_RATE = new Big("0.15");

/** A cash fund fee assumed when the catalog doesn't record one: on the high side for the kind. */
const ASSUMED_CASH_FUND_FEE = new Big("0.15");

const ZERO = new Big(0);
const money = (b: Big) => b.toFixed(2);
const trim = (s: string) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);

export interface Fee {
  expense_ratio: string;
  as_of: string | null;
  source_url: string | null;
}

export interface BrokerageInput {
  today: string;
  region: Region;
  snapshot: Snapshot;
  policy: Policy | null;
  catalog: SecurityCatalog;
  /** The SEC's fees by ticker (US funds only). */
  secFees: Map<string, Fee>;
  /** The cash yardstick in the owner's currency (src/facts/read.ts), or null. */
  benchmark: { name: string; yield: string; as_of: string; source_url: string } | null;
  /** Paid memberships the owner holds ("Robinhood Gold"). */
  memberships: string[];
  /** Workplace plan accounts, priced elsewhere. */
  planAccountIds: string[];
}

export interface BrokerageResult {
  items: Misallocation[];
  ran: Detector[];
  undecided: string[];
  warnings: string[];
  /** Tickers held in each priced account, for telling a swap made from one that went away. */
  tickers: Record<string, string[]>;
  /** Uninvested cash in each priced account. */
  cash: Record<string, string>;
}

/** Cash that sits as cash: Plaid's cash type with no fund ticker ("CUR:USD", or none). */
export function isIdleCash(h: SnapshotHolding): boolean {
  if (h.security_type !== "cash" && !(h.is_cash_equivalent && !h.ticker_symbol)) return false;
  const t = h.ticker_symbol?.trim();
  return !t || /^CUR:/i.test(t);
}

/** A fund's yearly fee: the SEC's for a US fund when it has one, else the catalog's. */
export function feeOf(
  ticker: string,
  catalog: SecurityCatalog,
  secFees: Map<string, Fee>,
): Fee | null {
  const entry = catalog.securities.find((s) => s.ticker === ticker);
  const sec = !entry || listedIn(entry) === "US" ? secFees.get(ticker) : undefined;
  if (sec) return sec;
  if (entry?.expense_ratio) {
    return {
      expense_ratio: entry.expense_ratio,
      as_of: entry.verified_on ?? null,
      source_url: entry.source_url ?? null,
    };
  }
  return null;
}

/** Accounts these detectors price: investment accounts outside a workplace plan and its window. */
function pricedAccounts(input: BrokerageInput): SnapshotAccount[] {
  const plans = new Set(input.planAccountIds);
  const windows = new Set(
    findOverlaps(input.snapshot.accounts, input.snapshot.holdings)
      .filter((o) => plans.has(o.account_id))
      .map((o) => o.same_as_account_id),
  );
  return input.snapshot.accounts.filter(
    (a) => a.type === "investment" && !plans.has(a.id) && !windows.has(a.id),
  );
}

const where = (a: SnapshotAccount) =>
  a.institution_name ? `${a.name} at ${a.institution_name}` : a.name;

const accountRef = (a: SnapshotAccount) => ({
  id: a.id,
  name: a.name,
  institution: a.institution_name ?? null,
});

export function brokerageFindings(input: BrokerageInput): BrokerageResult {
  const out: BrokerageResult = {
    items: [],
    ran: [],
    undecided: [],
    warnings: [],
    tickers: {},
    cash: {},
  };
  const accounts = pricedAccounts(input);
  for (const a of accounts) {
    const own = input.snapshot.holdings.filter(
      (h) => h.account_id === a.id && new Big(h.institution_value).gt(0),
    );
    out.tickers[a.id] = [
      ...new Set(own.flatMap((h) => (h.ticker_symbol ? [h.ticker_symbol.toUpperCase()] : []))),
    ];
    out.cash[a.id] = money(
      own.filter(isIdleCash).reduce((s, h) => s.plus(h.institution_value), ZERO),
    );
  }
  holdingFees(input, accounts, out);
  idleCash(input, accounts, out);
  allocationDrift(input, out);
  return out;
}

// holding_fee -------------------------------------------------------------------------------------

function holdingFees(input: BrokerageInput, accounts: SnapshotAccount[], out: BrokerageResult) {
  const { catalog, secFees, region } = input;
  const market = fundMarket(region.country);
  const byTicker = new Map(catalog.securities.map((s) => [s.ticker, s]));
  const held = new Set(Object.values(out.tickers).flat());
  const keepAdding: string[] = [];
  for (const a of accounts) {
    const sheltered = isTaxAdvantaged(a);
    for (const h of input.snapshot.holdings.filter((x) => x.account_id === a.id)) {
      const ticker = h.ticker_symbol?.toUpperCase();
      const value = new Big(h.institution_value);
      if (!ticker || value.lte(0)) continue;
      const fund = byTicker.get(ticker);
      if (!fund?.tracks) continue;
      const fee = feeOf(ticker, catalog, secFees);
      if (!fee) continue;
      const best = cheapestCopy(fund, market, catalog, secFees, held);
      if (!best || !new Big(best.fee.expense_ratio).lt(fee.expense_ratio)) continue;
      const saving = value.times(new Big(fee.expense_ratio).minus(best.fee.expense_ratio)).div(100);
      if (saving.lt(1)) continue;
      const key = `holding_fee:${a.id}:${ticker}`;

      // What selling costs in tax: nothing in a tax-sheltered account or below what was paid.
      let tax: Record<string, unknown>;
      let taxLine: string;
      if (sheltered) {
        tax = { kind: "sheltered" };
        taxLine = "Swapping inside this account owes no tax.";
      } else if (h.cost_basis == null) {
        out.warnings.push(
          `${where(a)} doesn't report what was paid for ${ticker}, so Tidysum can't tell the tax on swapping it for ${best.fund.ticker} (the same ${trackName(fund, catalog)} for less).`,
        );
        out.undecided.push(key);
        continue;
      } else if (new Big(h.cost_basis).gte(value)) {
        tax = { kind: "no_gain" };
        taxLine =
          region.country === "US"
            ? "Selling it now owes no tax. Buying a fund of the same index right away may count as a wash sale; then the loss moves into the new fund's cost instead of being lost."
            : "Selling it now owes no tax.";
      } else if (region.country !== "US") {
        // Capital gains tax outside the US isn't modeled: don't suggest selling at a gain.
        keepAdding.push(`${ticker} → ${best.fund.ticker}`);
        continue;
      } else {
        const gain = value.minus(h.cost_basis);
        const owed = gain.times(US_GAINS_RATE);
        const months = owed.div(saving).times(12).round(0, Big.roundUp);
        if (months.gt(MAX_PAYBACK_YEARS * 12)) {
          keepAdding.push(`${ticker} → ${best.fund.ticker}`);
          continue;
        }
        tax = {
          kind: "gain",
          gain: money(gain),
          rate: US_GAINS_RATE.toString(),
          tax: money(owed),
          payback_months: Number(months),
        };
        taxLine = `Selling owes tax on the gain; the lower fee pays it back in about ${months.toString()} month${months.eq(1) ? "" : "s"}.`;
      }

      const mutualFund = h.security_type === "mutual fund";
      out.items.push({
        key,
        category: "securities",
        detector: "holding_fee",
        summary: `${fund.name} (${ticker}) costs ${trim(fee.expense_ratio)}% a year. ${best.fund.name} (${best.fund.ticker}) holds the same ${trackName(fund, catalog)} for ${trim(best.fee.expense_ratio)}%. ${taxLine}`,
        annual_cost: money(saving),
        currency: region.currency,
        account_ids: [a.id],
        product_id: null,
        action: `Swap ${ticker} for ${best.fund.ticker} in ${a.name}`,
        inputs: {
          account: accountRef(a),
          ticker,
          name: fund.name,
          tracks: fund.tracks,
          tracks_label: trackName(fund, catalog),
          expense_ratio: fee.expense_ratio,
          fee_as_of: fee.as_of,
          fee_source: fee.source_url,
          value: money(value),
          alternative: {
            ticker: best.fund.ticker,
            name: best.fund.name,
            expense_ratio: best.fee.expense_ratio,
            fee_as_of: best.fee.as_of,
            fee_source: best.fee.source_url,
            held: held.has(best.fund.ticker),
          },
          tax,
          mutual_fund: mutualFund,
          // Selling a mutual fund leaves the money out of the market until it settles.
          ...(mutualFund ? { wait_for: "calm_markets" } : {}),
        },
      });
    }
  }
  if (keepAdding.length > 0) {
    out.warnings.push(
      `Cheaper funds hold the same as ${keepAdding.join(", ")}, but selling would owe tax on gains the lower fee takes more than ${MAX_PAYBACK_YEARS} years to pay back. Keep them, and buy the cheaper fund with new money instead.`,
    );
  }
  out.ran.push("holding_fee");
}

/** "S&P 500" for funds that copy each other: the cheapest one's name, with the index shown plain. */
const TRACK_NAMES: Record<string, string> = {
  sp500: "S&P 500",
  nasdaq100: "Nasdaq-100",
  us_total_market: "whole US stock market",
  intl_total_market: "whole stock market outside the US",
  us_aggregate_bonds: "US investment-grade bond market",
  gold_bullion: "gold bullion",
  sp_tsx_capped_composite: "S&P/TSX Composite",
  ftse_100: "FTSE 100",
  ftse_all_world: "FTSE All-World",
  msci_world: "MSCI World",
  msci_world_ex_usa: "MSCI World ex USA",
};

function trackName(fund: CatalogSecurity, catalog: SecurityCatalog): string {
  if (fund.tracks && TRACK_NAMES[fund.tracks]) return TRACK_NAMES[fund.tracks] as string;
  const [only] = Object.keys(fund.mix);
  return only ? sleeveLabel(catalog, only).toLowerCase() : "holdings";
}

/**
 * US mutual fund tickers: five letters ending in X. A fund family's mutual funds are cheap only at
 * its own brokerage (Schwab's at Schwab, Fidelity's at Fidelity) and cost a fee or can't be bought
 * elsewhere, so a swap goes to an ETF, which any brokerage sells.
 */
const US_MUTUAL_FUND = /^[A-Z]{4}X$/;

/** The cheapest other fund with the same `tracks`, listed where the owner buys funds. */
function cheapestCopy(
  fund: CatalogSecurity,
  market: string,
  catalog: SecurityCatalog,
  secFees: Map<string, Fee>,
  held: Set<string>,
): { fund: CatalogSecurity; fee: Fee } | null {
  const options = catalog.securities.flatMap((s) => {
    if (s.ticker === fund.ticker || s.tracks !== fund.tracks || listedIn(s) !== market) return [];
    if (market === "US" && US_MUTUAL_FUND.test(s.ticker)) return [];
    const fee = feeOf(s.ticker, catalog, secFees);
    return fee ? [{ fund: s, fee }] : [];
  });
  options.sort(
    (x, y) =>
      new Big(x.fee.expense_ratio).cmp(y.fee.expense_ratio) ||
      Number(held.has(y.fund.ticker)) - Number(held.has(x.fund.ticker)) ||
      x.fund.ticker.localeCompare(y.fund.ticker),
  );
  return options[0] ?? null;
}

// brokerage_cash ---------------------------------------------------------------------------------

function idleCash(input: BrokerageInput, accounts: SnapshotAccount[], out: BrokerageResult) {
  const { catalog, region, benchmark } = input;
  const withCash = accounts.filter((a) => new Big(out.cash[a.id] ?? 0).gt(0));
  if (!benchmark) {
    if (withCash.length > 0) {
      out.warnings.push(
        "No cash yardstick is imported yet for your currency, so uninvested brokerage cash isn't priced.",
      );
    }
    return;
  }
  const market = fundMarket(region.country);
  const altTicker = catalog.default_buy_by_country[market]?.cash ?? catalog.default_buy.cash;
  const alt = altTicker ? catalog.securities.find((s) => s.ticker === altTicker) : undefined;
  if (!altTicker || !alt) return;
  const altFee = feeOf(altTicker, catalog, input.secFees);
  const fundFee = altFee ? new Big(altFee.expense_ratio) : ASSUMED_CASH_FUND_FEE;
  const yardstick = new Big(benchmark.yield).minus(fundFee);
  out.ran.push("brokerage_cash");
  const held = new Set(input.memberships.map((m) => m.toLowerCase()));

  for (const a of withCash) {
    const cash = new Big(out.cash[a.id] ?? 0);
    const key = `brokerage_cash:${a.id}`;
    const terms = catalog.brokerage_cash.find(
      (b) =>
        (b.country ?? "US") === region.country &&
        atInstitution(a.institution_name ?? null, b.institutions),
    );
    if (!terms) {
      out.warnings.push(
        `${where(a)} holds uninvested cash, and Tidysum doesn't know what ${a.institution_name ?? "that brokerage"} pays on it, so it isn't priced.`,
      );
      out.undecided.push(key);
      continue;
    }
    const member = terms.membership && held.has(terms.membership.name.toLowerCase());
    const apy = new Big(member && terms.membership ? terms.membership.apy : terms.apy);
    const gap = yardstick.minus(apy);
    if (gap.lte(0)) continue;
    const annual = cash.times(gap).div(100);
    const earns = apy.eq(0)
      ? "earns nothing"
      : `earns ${trim(apy.toString())}%${member ? ` with ${terms.membership?.name}` : ""}`;
    out.items.push({
      key,
      category: "securities",
      detector: "brokerage_cash",
      summary: `Uninvested cash in ${where(a)} ${earns}. ${alt.name} (${altTicker}) pays about ${yardstick.toFixed(2)}% after its fee, in line with the ${benchmark.name} (${trim(benchmark.yield)}% on ${benchmark.as_of}).`,
      annual_cost: money(annual),
      currency: region.currency,
      account_ids: [a.id],
      product_id: null,
      action: `Put the uninvested cash in ${a.name} to work`,
      inputs: {
        account: accountRef(a),
        cash: money(cash),
        apy: apy.toString(),
        membership: member ? (terms.membership?.name ?? null) : null,
        membership_available:
          !member && terms.membership
            ? { name: terms.membership.name, apy: terms.membership.apy }
            : null,
        terms: {
          name: terms.name,
          source_url: terms.source_url,
          rates_as_of: terms.rates_as_of,
          verified_on: terms.verified_on,
        },
        benchmark,
        alternative: {
          ticker: altTicker,
          name: alt.name,
          expense_ratio: fundFee.toString(),
          fee_assumed: !altFee,
          yield: yardstick.toFixed(2),
        },
        invest_toward_mix: !!input.policy?.allocation,
      },
    });
  }
}

// allocation_drift --------------------------------------------------------------------------------

/** Covariance of two classes from the catalog's risk figures, in fractions a year. */
function covariance(risk: NonNullable<SecurityCatalog["risk"]>, a: string, b: string): Big {
  const va = risk.classes[a];
  const vb = risk.classes[b];
  if (!va || !vb) throw new Error(`no risk figures for ${a} or ${b}`);
  const rho = a === b ? "1" : (risk.correlations[`${a}|${b}`] ?? risk.correlations[`${b}|${a}`]);
  if (rho === undefined) throw new Error(`no correlation for ${a} and ${b}`);
  return new Big(va.volatility).div(100).times(new Big(vb.volatility).div(100)).times(rho);
}

/**
 * The yearly cost, as a fraction of the mix, of holding `current` instead of `target` (bucket
 * shares, each bucket an even blend of its classes): ½·γ·dᵀΣd, with γ the return over cash the
 * target earns per unit of its variance. Null when a class has no risk figures.
 */
export function driftCost(
  risk: NonNullable<SecurityCatalog["risk"]>,
  buckets: { classes: string[]; current: Big; target: Big }[],
): { rate: Big; gamma: Big } | null {
  const known = buckets.map((b) => b.classes.filter((c) => c in risk.classes));
  if (
    buckets.some((b, i) => (known[i]?.length ?? 0) === 0 && (b.current.gt(0) || b.target.gt(0)))
  ) {
    return null;
  }
  const cov = (i: number, j: number) => {
    const ci = known[i] ?? [];
    const cj = known[j] ?? [];
    if (ci.length === 0 || cj.length === 0) return ZERO;
    let s = ZERO;
    for (const a of ci) for (const b of cj) s = s.plus(covariance(risk, a, b));
    return s.div(ci.length * cj.length);
  };
  const cash = new Big(risk.classes[risk.riskless]?.expected_return ?? 0);
  const premium = (i: number) => {
    const ci = known[i] ?? [];
    if (ci.length === 0) return ZERO;
    return ci
      .reduce((s, c) => s.plus(new Big(risk.classes[c]?.expected_return ?? 0).minus(cash)), ZERO)
      .div(ci.length)
      .div(100);
  };
  const quad = (w: Big[]) => {
    let s = ZERO;
    for (let i = 0; i < w.length; i++)
      for (let j = 0; j < w.length; j++)
        s = s.plus((w[i] ?? ZERO).times(w[j] ?? ZERO).times(cov(i, j)));
    return s;
  };
  const target = buckets.map((b) => b.target);
  const variance = quad(target);
  const excess = target.reduce((s, t, i) => s.plus(t.times(premium(i))), ZERO);
  if (variance.lte(0) || excess.lte(0)) return null;
  const gamma = excess.div(variance);
  const d = buckets.map((b) => b.current.minus(b.target));
  return { rate: gamma.times(quad(d)).div(2), gamma };
}

function allocationDrift(input: BrokerageInput, out: BrokerageResult) {
  const { policy, catalog, snapshot, region } = input;
  if (!policy?.allocation || !catalog.risk) return;
  const report = buildAllocationReport(policy, snapshot, catalog, { amounts: true });
  out.ran.push("allocation_drift");
  if ("empty" in report || !report.rebalance || !report.amounts) return;
  const rows = report.buckets.map((b) => ({
    key: b.key,
    label: b.label,
    classes: b.classes,
    current: new Big(b.current).div(100),
    target: new Big(b.target).div(100),
    status: b.status,
    drift: b.drift,
  }));
  const priced = driftCost(catalog.risk, rows);
  if (!priced) {
    out.warnings.push(
      "Your mix is off its target, but a bucket holds a class with no published risk figures, so the drift isn't priced.",
    );
    return;
  }
  const invested = new Big(report.amounts.in_mix);
  const annual = invested.times(priced.rate);
  const off = rows.filter((r) => r.status !== "ok");
  const describe = (r: (typeof rows)[number]) =>
    `${r.label} ${r.current.times(100).toFixed(0)}% (target ${r.target.times(100).toFixed(0)}%)`;
  const ratePct = priced.rate.times(100);
  out.items.push({
    key: "allocation_drift",
    category: "securities",
    detector: "allocation_drift",
    summary: `Your mix is outside its ${trim(report.drift_band)}-point band: ${off.map(describe).join(", ")}. A mix you didn't choose takes risk you aren't paid for; by ${catalog.risk.name.replace(/ \(USD\)$/, "")}, that costs about ${ratePct.lt("0.01") ? ratePct.toFixed(3) : ratePct.toFixed(2)}% of what you have invested a year in risk-adjusted return. New money toward the target closes it with no selling.`,
    annual_cost: money(annual),
    currency: region.currency,
    account_ids: [],
    product_id: null,
    action: "Invest new money toward your target mix",
    inputs: {
      drift_band: report.drift_band,
      buckets: rows.map((r) => ({
        key: r.key,
        label: r.label,
        current: r.current.times(100).toFixed(1),
        target: r.target.times(100).toFixed(1),
        drift: r.drift,
        status: r.status,
      })),
      cost_rate: priced.rate.toFixed(6),
      risk_aversion: priced.gamma.toFixed(2),
      risk: {
        name: catalog.risk.name,
        source_url: catalog.risk.source_url,
        as_of: catalog.risk.as_of,
      },
      new_money: report.new_money,
    },
  });
}

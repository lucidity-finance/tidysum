import Big from "big.js";
import type { AgentDb } from "../mcp/agentDb.js";
import { regionOf } from "../region.js";
import { rebuildBalances } from "./cashHistory.js";
import { apyFor, atInstitution, type Catalog, type Product } from "./catalog.js";
import { DISCLOSURE } from "./disclosure.js";

// What each cash account earns and pays today, from its own transactions, against what the
// catalog's products would pay on the same balance. The difference is the money lost each year
// by not switching. Interest and fees are observed, not assumed: Plaid tags interest credits as
// INCOME_INTEREST_EARNED and fees as BANK_FEES_*, so an account that paid nothing for a year
// shows 0, and one that charged a monthly fee shows it.

/** Rates older than this are flagged so they get re-checked at the source. */
export const STALE_AFTER_DAYS = 30;
const WINDOW_DAYS = 365;
const AVERAGE_BALANCE_DAYS = 90;
const DAY_MS = 86_400_000;

const MAINTENANCE_FEES = ["BANK_FEES_OTHER_BANK_FEES"];
const OVERDRAFT_FEES = ["BANK_FEES_OVERDRAFT_FEES", "BANK_FEES_INSUFFICIENT_FUNDS"];

/** Which products can stand in for an account of each subtype. */
export const CANDIDATES: Record<string, readonly Product["kind"][]> = {
  checking: ["checking", "savings", "cash_management"],
  savings: ["savings", "cash_management"],
  "money market": ["savings", "cash_management"],
  "cash management": ["savings", "cash_management"],
};

export interface CashAccountFacts {
  id: string;
  name: string;
  /** The deposit product the owner picked for this account's spare money, if any. */
  chosen_product_id?: string | null;
  institution_name: string | null;
  subtype: string;
  currency: string | null;
  latest_balance: string | null;
  /**
   * Mean of the daily balances over the past 90 days: rebuilt from transactions when they cover
   * all 90 days, otherwise each day's last snapshot. null without either.
   */
  average_balance: string | null;
  balance_days: number;
  /** Whether average_balance was rebuilt from transactions rather than snapshots. */
  balance_rebuilt?: boolean;
  /** Earliest transaction date on the account, or null with no history. */
  first_transaction: string | null;
  interest: string;
  maintenance_fees: string;
  overdraft_fees: string;
}

export async function readCashAccounts(db: AgentDb, today: string): Promise<CashAccountFacts[]> {
  const { rows } = await db.query<CashAccountFacts & { latest_balance_on: string | null }>(
    `select a.id, a.name, i.institution_name, a.subtype, a.currency,
       dc.product_id as chosen_product_id,
       latest.current::text as latest_balance,
       to_char(latest.as_of at time zone 'UTC', 'YYYY-MM-DD') as latest_balance_on,
       avgb.average_balance, coalesce(avgb.days, 0)::int as balance_days,
       first_t.first_date::text as first_transaction,
       coalesce(flows.interest, 0)::text as interest,
       coalesce(flows.maintenance, 0)::text as maintenance_fees,
       coalesce(flows.overdraft, 0)::text as overdraft_fees
     from account a
     join item i on i.id = a.item_id
     left join deposit_choice dc on dc.account_id = a.id
     left join lateral (
       select s.current, s.as_of from balance_snapshot s
       where s.account_id = a.id and s.current is not null
       order by s.as_of desc limit 1
     ) latest on true
     left join lateral (
       select avg(d.current)::text as average_balance, count(*) as days from (
         select distinct on (s.as_of::date) s.current from balance_snapshot s
         where s.account_id = a.id and s.current is not null
           and s.as_of >= $1::date - ${AVERAGE_BALANCE_DAYS} and s.as_of < $1::date + 1
         order by s.as_of::date, s.as_of desc
       ) d
     ) avgb on true
     left join lateral (
       select min(t.date) as first_date from transaction t
       where t.account_id = a.id and t.removed_at is null
     ) first_t on true
     left join lateral (
       select
         -sum(t.amount) filter (where t.category_detailed = 'INCOME_INTEREST_EARNED') as interest,
         sum(t.amount) filter (where t.category_detailed = any($2::text[])) as maintenance,
         sum(t.amount) filter (where t.category_detailed = any($3::text[])) as overdraft
       from transaction t
       where t.account_id = a.id and t.removed_at is null and not t.pending
         and t.date > $1::date - ${WINDOW_DAYS} and t.date <= $1::date
     ) flows on true
     where a.type = 'depository' and a.subtype = any($4::text[])
     order by i.institution_name nulls last, a.name`,
    [today, MAINTENANCE_FEES, OVERDRAFT_FEES, Object.keys(CANDIDATES)],
  );
  // A few days of snapshots (a newly linked account) can land on a payday and say little about
  // the usual balance, so when the transactions cover the whole window, rebuild every day.
  const from = addDays(today, -(AVERAGE_BALANCE_DAYS - 1));
  return Promise.all(
    rows.map(async ({ latest_balance_on, ...f }): Promise<CashAccountFacts> => {
      if (f.latest_balance === null || latest_balance_on === null) return f;
      const { rows: firsts } = await db.query<{ first: string | null }>(
        `select min(t.date)::text as first from transaction t
         where t.account_id = $1 and t.removed_at is null and not t.pending`,
        [f.id],
      );
      const first = firsts[0]?.first;
      if (!first || first > from) return f;
      const { rows: flows } = await db.query<{ date: string; amount: string }>(
        `select t.date::text as date, sum(t.amount)::text as amount
         from transaction t
         where t.account_id = $1 and t.removed_at is null and not t.pending and t.date >= $2::date
         group by t.date order by t.date`,
        [f.id, from],
      );
      const balances = rebuildBalances(f.latest_balance, latest_balance_on, flows, from, today);
      const sum = [...balances.values()].reduce((s, b) => s.plus(b), new Big(0));
      return {
        ...f,
        average_balance: sum.div(balances.size).toFixed(4),
        balance_days: balances.size,
        balance_rebuilt: true,
      };
    }),
  );
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

const money = (b: Big) => b.toFixed(2);

export interface Alternative {
  product_id: string;
  provider: string;
  /** Institution names that mean the user holds an account with this provider. */
  institutions: string[];
  name: string;
  kind: Product["kind"];
  insurance: string;
  /** APY used for annual_gain: the conditional rate when the product has one. */
  apy: string;
  requires: string | null;
  annual_interest: string;
  annual_fees: string;
  /** Extra money per year over the current account, with any condition met. */
  annual_gain: string;
  monthly_gain: string;
  /** The same without meeting the condition (equals annual_gain when there is none). */
  annual_gain_without_conditions: string;
  notes: string | null;
  source_url: string;
  rates_as_of: string;
  verified_on: string;
  stale: boolean;
}

export interface AccountComparison {
  account_id: string;
  account_name: string;
  institution_name: string | null;
  subtype: string;
  balance: string;
  balance_basis: string;
  current: {
    annual_interest: string;
    annual_fees: string;
    effective_apy: string;
    /** Days of transactions the interest and fees were observed over, up to 365. */
    observed_days: number;
    basis: string;
  };
  /**
   * Products that would earn more, best first, except that the owner's pick comes first when
   * they made one. Empty when nothing beats the account.
   */
  alternatives: Alternative[];
  /** The owner's pick for this account's spare money (deposit_choice), when they made one. */
  chosen_product_id: string | null;
  skipped?: string;
}

export interface Comparison {
  as_of: string;
  /** Sum over accounts of the best alternative's annual_gain. */
  annual_loss: string;
  monthly_loss: string;
  /** Same, using only rates that need no direct deposit or other condition. */
  annual_loss_without_conditions: string;
  accounts: AccountComparison[];
  warnings: string[];
  assumptions: string[];
  disclosure: string;
}

const ASSUMPTIONS = [
  "Gains are before tax; interest is taxed as ordinary income.",
  "The balance stays at the level shown and the APY stays where it is today.",
  "Current interest and fees come from this account's own transactions over the last year " +
    "(Plaid categories INCOME_INTEREST_EARNED, BANK_FEES_OTHER_BANK_FEES, BANK_FEES_OVERDRAFT_FEES " +
    "and BANK_FEES_INSUFFICIENT_FUNDS), annualized when there is less than a year of history.",
  "Limited-time promotional rates and sign-up bonuses are left out.",
  "Checking balances are also compared with savings and cash management products, since money " +
    "held as a cash buffer doesn't need to sit in checking.",
];

/** The account's own subtype as a catalog kind. */
const OWN_KIND: Record<string, Product["kind"]> = {
  checking: "checking",
  savings: "savings",
  "money market": "savings",
  "cash management": "cash_management",
};

/**
 * Whether the account probably is this product: same provider, same kind. A new account has no
 * interest history yet, so without this it would be told to switch to itself.
 */
function isThisProduct(f: CashAccountFacts, p: Product): boolean {
  return atInstitution(f.institution_name, p.institutions) && OWN_KIND[f.subtype] === p.kind;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

export function compareProducts(
  catalog: Catalog,
  facts: CashAccountFacts[],
  today: string,
): Comparison {
  const warnings: string[] = [];
  const stale = new Set<string>();
  const catalogCurrencies = new Set(catalog.products.map((p) => regionOf(p.country).currency));
  for (const p of catalog.products) {
    const age = daysBetween(p.verified_on, today);
    if (age > STALE_AFTER_DAYS) {
      stale.add(p.id);
      warnings.push(
        `${p.name} was last verified ${age} days ago (${p.verified_on}); re-check ${p.source_url}.`,
      );
    }
  }

  let annualLoss = new Big(0);
  let annualLossNoConditions = new Big(0);
  const accounts = facts.map((f): AccountComparison => {
    const avg = f.average_balance ? new Big(f.average_balance) : null;
    const balance = avg ?? new Big(f.latest_balance ?? 0);
    const balanceBasis = f.balance_rebuilt
      ? `average of the last ${f.balance_days} days' balances, rebuilt from transactions`
      : avg
        ? `average of ${f.balance_days} daily balance${f.balance_days === 1 ? "" : "s"} in the last ${AVERAGE_BALANCE_DAYS} days`
        : f.latest_balance
          ? "latest balance"
          : "no balance synced";

    const observedDays = f.first_transaction
      ? Math.min(WINDOW_DAYS, daysBetween(f.first_transaction, today) + 1)
      : 0;
    const annualize = (s: string) =>
      observedDays > 0 ? new Big(s).times(WINDOW_DAYS).div(observedDays) : new Big(0);
    const interest = annualize(f.interest);
    const overdraft = annualize(f.overdraft_fees);
    const fees = annualize(f.maintenance_fees).plus(overdraft);
    const net = interest.minus(fees);
    const current = {
      annual_interest: money(interest),
      annual_fees: money(fees),
      effective_apy: balance.gt(0) ? interest.div(balance).times(100).toFixed(2) : "0.00",
      observed_days: observedDays,
      basis:
        observedDays === 0
          ? "no transactions synced yet, so current interest and fees are taken as 0"
          : observedDays < WINDOW_DAYS
            ? `${observedDays} days of transactions, annualized`
            : "the last 365 days of transactions",
    };
    const base = {
      chosen_product_id: f.chosen_product_id ?? null,
      account_id: f.id,
      account_name: f.name,
      institution_name: f.institution_name,
      subtype: f.subtype,
      balance: money(balance),
      balance_basis: balanceBasis,
      current,
    };
    if (!catalogCurrencies.has(f.currency ?? "USD")) {
      return {
        ...base,
        alternatives: [],
        skipped: catalog.products.length
          ? `the catalog has no accounts in ${f.currency}`
          : "the catalog has no accounts in your country yet",
      };
    }
    if (balance.lte(0)) return { ...base, alternatives: [], skipped: "no positive balance" };
    if (observedDays > 0 && observedDays < 28) {
      warnings.push(
        `${f.name}: only ${observedDays} days of transactions, so its current interest and fees are rough.`,
      );
    }

    const kinds = CANDIDATES[f.subtype] ?? [];
    const alternatives = catalog.products
      .filter((p) => kinds.includes(p.kind) && !isThisProduct(f, p))
      .map((p): Alternative => {
        const annualFees = new Big(p.monthly_fee).times(12).plus(p.overdraft_fees ? overdraft : 0);
        const gainAt = (apy: Big) => balance.times(apy).div(100).minus(annualFees).minus(net);
        const baseApy = apyFor(p.apy, balance);
        const bestApy = p.conditional_apy ? apyFor(p.conditional_apy.apy, balance) : baseApy;
        const gain = gainAt(bestApy);
        return {
          product_id: p.id,
          provider: p.provider,
          institutions: p.institutions,
          name: p.name,
          kind: p.kind,
          insurance: p.insurance,
          apy: bestApy.toFixed(2),
          requires: p.conditional_apy?.requires ?? null,
          annual_interest: money(balance.times(bestApy).div(100)),
          annual_fees: money(annualFees),
          annual_gain: money(gain),
          monthly_gain: money(gain.div(12)),
          annual_gain_without_conditions: money(gainAt(baseApy)),
          notes: p.notes ?? null,
          source_url: p.source_url,
          rates_as_of: p.rates_as_of,
          verified_on: p.verified_on,
          stale: stale.has(p.id),
        };
      })
      .filter((a) => new Big(a.annual_gain).gt(0))
      .sort(
        (a, b) =>
          // The owner's pick leads: it's where the money is going, even if another pays more.
          Number(b.product_id === f.chosen_product_id) -
            Number(a.product_id === f.chosen_product_id) ||
          new Big(b.annual_gain).cmp(a.annual_gain),
      );

    if (alternatives[0]) annualLoss = annualLoss.plus(alternatives[0].annual_gain);
    const bestNoConditions = alternatives.reduce(
      (best, a) =>
        new Big(a.annual_gain_without_conditions).gt(best)
          ? new Big(a.annual_gain_without_conditions)
          : best,
      new Big(0),
    );
    annualLossNoConditions = annualLossNoConditions.plus(bestNoConditions);
    return { ...base, alternatives };
  });

  return {
    as_of: today,
    annual_loss: money(annualLoss),
    monthly_loss: money(annualLoss.div(12)),
    annual_loss_without_conditions: money(annualLossNoConditions),
    accounts,
    warnings,
    assumptions: ASSUMPTIONS,
    disclosure: DISCLOSURE,
  };
}

/**
 * "Wealthfront Cash Account" or "SoFi Savings", not "Wealthfront Brokerage LLC Wealthfront Cash
 * Account" or "SoFi Bank, N.A. SoFi Savings": the provider's legal name only when the product
 * name doesn't already carry the brand.
 */
export function productLabel(provider: string | null | undefined, name: string | null | undefined) {
  const p = provider?.trim() ?? "";
  if (!name) return p;
  const brand = p.split(/[\s,]+/)[0]?.toLowerCase() ?? "";
  return brand && name.toLowerCase().includes(brand) ? name : `${p} ${name}`.trim();
}

export async function readAndCompare(db: AgentDb, catalog: Catalog, today: string) {
  return compareProducts(catalog, await readCashAccounts(db, today), today);
}

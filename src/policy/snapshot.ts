import type { AgentDb } from "../mcp/agentDb.js";
import { regionOf } from "../region.js";
import { asPlanFund, findFund, readWorkplacePlans } from "../retirement/workplace.js";

// The numbers the policy engine works from, read in one go so every finding and every
// validation in a call uses the same data. All money is decimal strings.

export interface SnapshotAccount {
  id: string;
  name: string;
  official_name?: string | null;
  institution_name?: string | null;
  type: string;
  subtype: string | null;
  currency: string | null;
  current: string | null;
  available: string | null;
  balance_as_of: string | null;
}

export interface SnapshotLiability {
  account_id: string;
  name: string;
  kind: string;
  apr_percentage: string | null;
  last_statement_balance: string | null;
  minimum_payment: string | null;
  next_payment_due_date: string | null;
  current_balance: string | null;
  /** Interest actually charged on this account in the 365 days before `today`. */
  interest_charged_365d: string;
}

export interface SnapshotHolding {
  account_id: string;
  security_id?: string;
  ticker_symbol: string | null;
  security_name: string | null;
  is_cash_equivalent: boolean | null;
  security_type: string | null;
  institution_value: string;
  cost_basis?: string | null;
  /** Set on holdings the owner entered by hand: the one asset class the whole value is in. */
  asset_class?: string;
  /**
   * What a workplace-plan fund holds, from the plan's recorded lineup, when the fund has no
   * ticker ("The International Equity Index Fund"): asset classes or sleeves adding up to 1.
   */
  plan_mix?: Record<string, string>;
}

/** A holding no data source reaches (Treasuries at TreasuryDirect), entered by the owner. */
export interface ManualHolding {
  id: string;
  name: string;
  asset_class: string;
  value: string;
  as_of: string;
}

export interface Snapshot {
  today: string;
  /**
   * The user's home currency (src/region.ts). Every amount below is in it: accounts in another
   * currency are left out rather than added up as if they were the same money.
   */
  currency?: string;
  /** The user's country (src/region.ts). */
  country?: string;
  /** Accounts left out because they are in another currency. */
  other_currency_accounts?: { id: string; name: string; currency: string }[];
  /** Whether this user gets allocation checks and securities proposals (app_user.investing_enabled). */
  investing_enabled: boolean;
  accounts: SnapshotAccount[];
  liabilities: SnapshotLiability[];
  holdings: SnapshotHolding[];
  /** Investments entered by hand; they belong to no account. */
  manual_holdings?: ManualHolding[];
  /** Posted spending per calendar month for the three full months before `today`. */
  spending: { month: string; outflow: string }[];
  /**
   * investment-miner's newest completed run per list and the tickers it ranks: research
   * evidence for the research sleeve, shared by every user (not personal data).
   */
  research?: ResearchSnapshot;
}

export interface ResearchSnapshot {
  runs: { run_id: string; product: string; watchlist: string; as_of: string }[];
  /** Every ticker those runs rank (their imported top candidates), upper case. */
  tickers: string[];
}

export async function readSnapshot(db: AgentDb, today: string): Promise<Snapshot> {
  // Row-level security leaves only the session user's own row.
  const user = await db.query<{ investing_enabled: boolean; country: string }>(
    "select investing_enabled, country from app_user",
  );
  const { currency, country } = regionOf(user.rows[0]?.country);
  const accounts = await db.query<SnapshotAccount>(`
    select a.id, a.name, a.official_name, i.institution_name, a.type, a.subtype, a.currency,
      b.current, b.available, b.as_of as balance_as_of
    from account a
    join item i on i.id = a.item_id
    left join lateral (
      select s.current, s.available, s.as_of from balance_snapshot s
      where s.account_id = a.id order by s.as_of desc limit 1
    ) b on true
    order by a.name`);
  const liabilities = await db.query<SnapshotLiability>(
    `
    select l.account_id, a.name, l.kind, l.apr_percentage, l.last_statement_balance,
      l.minimum_payment, l.next_payment_due_date, b.current as current_balance,
      coalesce((
        select sum(t.amount) from transaction t
        where t.account_id = l.account_id and t.removed_at is null and not t.pending
          and t.amount > 0 and t.category_detailed = 'BANK_FEES_INTEREST_CHARGE'
          and t.date > $1::date - 365 and t.date <= $1::date
      ), 0)::text as interest_charged_365d
    from liability l
    join account a on a.id = l.account_id
    left join lateral (
      select s.current from balance_snapshot s
      where s.account_id = a.id order by s.as_of desc limit 1
    ) b on true
    order by a.name`,
    [today],
  );
  const holdings = await db.query<SnapshotHolding>(`
    select h.account_id, h.security_id, s.ticker_symbol, s.name as security_name, s.is_cash_equivalent,
      s.type as security_type,
      h.institution_value, h.cost_basis
    from holding h join security s on s.id = h.security_id`);
  const plans = new Map((await readWorkplacePlans(db)).map((p) => [p.account_id, p.facts]));
  holdings.rows = holdings.rows.map((row) => {
    const plan = plans.get(row.account_id);
    if (!plan) return row;
    const h = asPlanFund(plan, row);
    const mix = !h.ticker_symbol ? findFund(plan.lineup, h.security_name)?.mix : undefined;
    return mix ? { ...h, plan_mix: mix } : h;
  });
  const manual = await db.query<ManualHolding>(
    `select id, name, asset_class, value::text as value, as_of::text as as_of
     from manual_holding order by name`,
  );
  // Same exclusions as cash_flow_summary: transfers between own accounts and card payments
  // would count twice. Refunds are not netted out, so this errs high, which is the safe side
  // for a buffer.
  const spending = await db.query<{ month: string; outflow: string }>(
    `select to_char(t.date, 'YYYY-MM') as month, sum(t.amount)::text as outflow
     from transaction t
     where t.removed_at is null and not t.pending and t.amount > 0
       and t.date >= date_trunc('month', $1::date) - interval '3 months'
       and t.date < date_trunc('month', $1::date)
       and coalesce(t.category_primary, '') not in ('TRANSFER_IN', 'TRANSFER_OUT')
       and coalesce(t.category_detailed, '') <> 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
       and coalesce(t.currency, $2) = $2
     group by 1 order by 1`,
    [today, currency],
  );
  const runs = await db.query<ResearchSnapshot["runs"][number]>(
    `select distinct on (product, watchlist) run_id, product, watchlist,
       to_char(as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as as_of
     from research_run order by product, watchlist, as_of desc`,
  );
  const ranked = runs.rows.length
    ? await db.query<{ ticker: string }>(
        "select distinct upper(ticker) as ticker from research_candidate where run_id = any($1::text[]) order by 1",
        [runs.rows.map((r) => r.run_id)],
      )
    : { rows: [] };
  // An account with no currency is taken as the home one, as Plaid leaves it off rarely.
  const other = accounts.rows.filter((a) => a.currency !== null && a.currency !== currency);
  const otherIds = new Set(other.map((a) => a.id));
  const home = <T extends { account_id: string }>(rows: T[]) =>
    rows.filter((r) => !otherIds.has(r.account_id));
  return {
    today,
    country,
    currency,
    ...(other.length
      ? {
          other_currency_accounts: other.map((a) => ({
            id: a.id,
            name: a.name,
            currency: a.currency ?? "",
          })),
        }
      : {}),
    investing_enabled: user.rows[0]?.investing_enabled ?? false,
    accounts: accounts.rows.filter((a) => !otherIds.has(a.id)),
    liabilities: home(liabilities.rows),
    holdings: home(holdings.rows),
    manual_holdings: manual.rows,
    spending: spending.rows,
    research: { runs: runs.rows, tickers: ranked.rows.map((r) => r.ticker) },
  };
}

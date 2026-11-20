import type { SnapshotAccount, SnapshotHolding } from "../policy/snapshot.js";
import { findOverlaps, type Overlap } from "../portfolio/overlap.js";
import type { AgentDb } from "./agentDb.js";

// Read-only reporting queries behind the MCP tools. They run as tidysum_agent, so they can only
// see what that role is granted (no item_secret, no Plaid cursors). Money stays a decimal string
// end to end: sums happen in Postgres numeric and come back as text.

/** Builds a WHERE clause with numbered parameters. */
class Where {
  readonly params: unknown[] = [];
  private readonly clauses: string[] = [];

  constructor(...fixed: string[]) {
    this.clauses.push(...fixed);
  }

  param(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  add(clause: string): void {
    this.clauses.push(clause);
  }

  toString(): string {
    return this.clauses.length ? `where ${this.clauses.join(" and ")}` : "";
  }
}

const LIABILITY_TYPES = "('credit', 'loan')";

/** Transfers between the owner's own accounts, which would count twice as in and out. */
const NOT_TRANSFER = `coalesce(t.category_primary, '') not in ('TRANSFER_IN', 'TRANSFER_OUT')
  and coalesce(t.category_detailed, '') <> 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'`;

const LATEST_BALANCE = `left join lateral (
    select s.current, s.available, s.credit_limit, s.as_of
    from balance_snapshot s where s.account_id = a.id
    order by s.as_of desc limit 1
  ) b on true`;

export async function listAccounts(db: AgentDb) {
  const { rows } = await db.query(`
    select a.id, a.name, a.official_name, a.type, a.subtype, a.mask, a.currency,
      i.institution_name, i.source, i.status as item_status, i.status_detail as item_status_detail,
      i.last_synced_at,
      b.current as current_balance, b.available as available_balance, b.credit_limit,
      b.as_of as balance_as_of
    from account a
    join item i on i.id = a.item_id
    ${LATEST_BALANCE}
    order by i.institution_name nulls last, a.name`);
  return { accounts: rows };
}

export interface TransactionQuery {
  from?: string | undefined;
  to?: string | undefined;
  accountIds?: string[] | undefined;
  search?: string | undefined;
  categoryPrimary?: string | undefined;
  minAmount?: string | undefined;
  maxAmount?: string | undefined;
  includePending: boolean;
  limit: number;
  offset: number;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function queryTransactions(db: AgentDb, q: TransactionQuery) {
  const w = new Where("t.removed_at is null");
  if (q.from) w.add(`t.date >= ${w.param(q.from)}::date`);
  if (q.to) w.add(`t.date <= ${w.param(q.to)}::date`);
  if (q.accountIds?.length) w.add(`t.account_id = any(${w.param(q.accountIds)}::uuid[])`);
  if (q.search) {
    const p = w.param(`%${escapeLike(q.search)}%`);
    w.add(`(t.name ilike ${p} or t.merchant_name ilike ${p})`);
  }
  if (q.categoryPrimary) w.add(`t.category_primary = ${w.param(q.categoryPrimary)}`);
  if (q.minAmount) w.add(`t.amount >= ${w.param(q.minAmount)}::numeric`);
  if (q.maxAmount) w.add(`t.amount <= ${w.param(q.maxAmount)}::numeric`);
  if (!q.includePending) w.add("not t.pending");
  const limit = w.param(q.limit + 1);
  const offset = w.param(q.offset);
  const { rows } = await db.query(
    `select t.id, t.date, t.authorized_date, t.amount, t.currency, t.name, t.merchant_name,
       t.category_primary, t.category_detailed, t.pending, t.account_id, a.name as account_name
     from transaction t join account a on a.id = t.account_id
     ${w}
     order by t.date desc, t.id
     limit ${limit} offset ${offset}`,
    w.params,
  );
  const more = rows.length > q.limit;
  return {
    transactions: more ? rows.slice(0, q.limit) : rows,
    next_offset: more ? q.offset + q.limit : null,
  };
}

/**
 * Investment accounts that another account already reports as one lump position, like a 401(k)'s
 * brokerage window (see src/portfolio/overlap.ts).
 */
export async function readOverlaps(db: AgentDb): Promise<Overlap[]> {
  const { rows: accounts } = await db.query<SnapshotAccount>(`
    select a.id, a.name, a.official_name, i.institution_name, a.type, a.subtype, a.currency,
      b.current, b.available, b.as_of as balance_as_of
    from account a join item i on i.id = a.item_id
    ${LATEST_BALANCE}
    where a.type = 'investment'`);
  const { rows: holdings } = await db.query<SnapshotHolding>(`
    select h.account_id, h.security_id, s.ticker_symbol, s.name as security_name,
      s.is_cash_equivalent, s.type as security_type, h.institution_value
    from holding h join security s on s.id = h.security_id`);
  return findOverlaps(accounts, holdings);
}

export async function getHoldings(db: AgentDb, accountIds?: string[]) {
  const w = new Where();
  if (accountIds?.length) w.add(`h.account_id = any(${w.param(accountIds)}::uuid[])`);
  const { rows: holdings } = await db.query(
    `select h.account_id, a.name as account_name, s.id as security_id, s.name as security_name,
       s.ticker_symbol, s.type as security_type, s.is_cash_equivalent, h.quantity,
       h.institution_price, h.institution_value, h.cost_basis, h.currency, h.as_of,
       trim_scale(ff.expense_ratio)::text as expense_ratio, ff.as_of as expense_ratio_as_of, ff.source_url as expense_ratio_source
     from holding h
     join account a on a.id = h.account_id
     join security s on s.id = h.security_id
     left join lateral (
       select f.expense_ratio, f.as_of, f.source_url from fund_fee f
       where f.ticker = upper(s.ticker_symbol) order by f.filed desc limit 1
     ) ff on true
     ${w}
     order by a.name, h.institution_value desc`,
    w.params,
  );
  const { rows: totals } = await db.query(
    `select h.account_id, a.name as account_name, h.currency,
       sum(h.institution_value)::text as total_value,
       sum(h.cost_basis)::text as total_cost_basis
     from holding h join account a on a.id = h.account_id
     ${w}
     group by h.account_id, a.name, h.currency
     order by a.name`,
    w.params,
  );
  // Totals are as reported. A lump listed here is the same money as another account, so add the
  // totals up without it.
  const overlaps = await readOverlaps(db);
  const counted_once = overlaps.map((o) => ({
    account_id: o.account_id,
    security_id: o.security_id,
    security_name: o.security_name,
    same_as_account_id: o.same_as_account_id,
    same_as_account_name: o.same_as_account_name,
  }));
  return { holdings, totals, counted_once };
}

export async function getLiabilities(db: AgentDb) {
  const { rows } = await db.query(`
    select l.account_id, a.name as account_name, a.mask, a.currency, l.kind, l.apr_percentage,
      b.current as current_balance, l.last_statement_balance, l.minimum_payment,
      l.next_payment_due_date, l.is_overdue, l.as_of
    from liability l
    join account a on a.id = l.account_id
    ${LATEST_BALANCE}
    order by l.next_payment_due_date nulls last, a.name`);
  return { liabilities: rows };
}

export interface CashFlowQuery {
  from: string;
  to: string;
  groupBy: "month" | "category";
  includePending: boolean;
  excludeTransfers: boolean;
}

export async function cashFlowSummary(db: AgentDb, q: CashFlowQuery) {
  const w = new Where("t.removed_at is null");
  w.add(`t.date between ${w.param(q.from)}::date and ${w.param(q.to)}::date`);
  if (!q.includePending) w.add("not t.pending");
  if (q.excludeTransfers) w.add(NOT_TRANSFER);
  const key =
    q.groupBy === "month"
      ? "to_char(t.date, 'YYYY-MM')"
      : "coalesce(t.category_primary, 'UNCATEGORIZED')";
  const sums = `
    sum(case when t.amount < 0 then -t.amount else 0 end)::text as inflow,
    sum(case when t.amount > 0 then t.amount else 0 end)::text as outflow,
    (-sum(t.amount))::text as net,
    count(*)::int as transaction_count`;
  const { rows: groups } = await db.query(
    `select ${key} as key, t.currency, ${sums}
     from transaction t ${w}
     group by 1, t.currency
     order by 1, t.currency`,
    w.params,
  );
  const { rows: totals } = await db.query(
    `select t.currency, ${sums} from transaction t ${w} group by t.currency order by t.currency`,
    w.params,
  );
  return { from: q.from, to: q.to, group_by: q.groupBy, groups, totals };
}

export interface NetWorthQuery {
  from: string;
  to: string;
  interval: "day" | "week" | "month";
}

export async function netWorthHistory(db: AgentDb, q: NetWorthQuery) {
  // An account another one already includes (a 401(k)'s brokerage window) is left out, so the
  // money counts once. Overlaps are found from today's holdings and applied to every point.
  const counted = (await readOverlaps(db)).map((o) => o.same_as_account_id);
  const { rows } = await db.query(
    `with points as (
       select d::date as on_date from generate_series($1::date, $2::date, $3::interval) d
       union select $2::date
     )
     select p.on_date, coalesce(b.currency, a.currency) as currency,
       coalesce(sum(b.current) filter (where a.type not in ${LIABILITY_TYPES}), 0)::text as assets,
       coalesce(sum(b.current) filter (where a.type in ${LIABILITY_TYPES}), 0)::text as liabilities,
       (coalesce(sum(b.current) filter (where a.type not in ${LIABILITY_TYPES}), 0)
         - coalesce(sum(b.current) filter (where a.type in ${LIABILITY_TYPES}), 0))::text
         as net_worth,
       count(*)::int as account_count
     from points p
     cross join account a
     join lateral (
       select s.current, s.currency from balance_snapshot s
       where s.account_id = a.id and s.as_of < p.on_date + 1 and s.current is not null
       order by s.as_of desc limit 1
     ) b on true
     where a.id <> all($4::uuid[])
     group by p.on_date, 2
     order by p.on_date, 2`,
    [q.from, q.to, `1 ${q.interval}`, counted],
  );
  return {
    from: q.from,
    to: q.to,
    interval: q.interval,
    points: rows,
    left_out_as_counted_elsewhere: counted,
  };
}

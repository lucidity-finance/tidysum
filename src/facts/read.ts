import Big from "big.js";
import type { AgentDb } from "../mcp/agentDb.js";
import { readAgentRegion } from "../users.js";
import { CANADA_TBILL_SERIES, TREASURY_SERIES } from "./refresh.js";

// The public facts as agents and the page read them, through the read-only agent role.

export interface FundFeeFact {
  ticker: string;
  fund_name: string;
  class_name: string | null;
  expense_ratio: string;
  gross_expense_ratio: string | null;
  as_of: string;
  filed: string;
  source_url: string;
}

/** The SEC's latest fee for each ticker that has one. */
export async function readFundFees(
  db: AgentDb,
  tickers: string[],
): Promise<Map<string, FundFeeFact>> {
  const wanted = [...new Set(tickers.map((t) => t.toUpperCase()))];
  if (wanted.length === 0) return new Map();
  const { rows } = await db.query<FundFeeFact>(
    `select distinct on (ticker) ticker, fund_name, class_name, trim_scale(expense_ratio)::text as expense_ratio,
       trim_scale(gross_expense_ratio)::text as gross_expense_ratio, as_of, filed, source_url
     from fund_fee where ticker = any($1::text[])
     order by ticker, filed desc`,
    [wanted],
  );
  return new Map(rows.map((r) => [r.ticker, r]));
}

/**
 * What each held fund costs a year: its expense ratio (from the SEC) times what the position is
 * worth. Positions with no ticker, or a ticker the SEC data has no fee for (a stock, a fund the
 * data doesn't cover), are listed as unknown, never priced at zero.
 */
export async function readHoldingFees(db: AgentDb) {
  const { rows } = await db.query<{
    account_id: string;
    account_name: string;
    security_name: string | null;
    ticker_symbol: string | null;
    security_type: string | null;
    institution_value: string;
  }>(
    `select h.account_id, a.name as account_name, s.name as security_name, s.ticker_symbol,
       s.type as security_type, h.institution_value::text
     from holding h
     join account a on a.id = h.account_id
     join security s on s.id = h.security_id
     where h.institution_value > 0
     order by h.institution_value desc`,
  );
  const fees = await readFundFees(
    db,
    rows.flatMap((r) => (r.ticker_symbol ? [r.ticker_symbol] : [])),
  );
  let total = new Big(0);
  let priced = new Big(0);
  const funds = rows.map((r) => {
    const fee = r.ticker_symbol ? fees.get(r.ticker_symbol.toUpperCase()) : undefined;
    const value = new Big(r.institution_value);
    total = total.plus(value);
    if (!fee) {
      return {
        account_id: r.account_id,
        account_name: r.account_name,
        security_name: r.security_name,
        ticker: r.ticker_symbol,
        expense_ratio: null,
        annual_cost: null,
        why_unknown:
          r.security_type === "equity"
            ? "a stock: it has no expense ratio"
            : r.ticker_symbol
              ? "not in the SEC's prospectus data (unit trusts like SPY and QQQ aren't)"
              : "no ticker",
      };
    }
    priced = priced.plus(value);
    return {
      account_id: r.account_id,
      account_name: r.account_name,
      security_name: r.security_name,
      ticker: r.ticker_symbol,
      expense_ratio: fee.expense_ratio,
      annual_cost: value.times(fee.expense_ratio).div(100).toFixed(2),
      fee_as_of: fee.as_of,
      source_url: fee.source_url,
    };
  });
  const yearly = funds.reduce((s, f) => (f.annual_cost ? s.plus(f.annual_cost) : s), new Big(0));
  return {
    funds,
    annual_cost: yearly.toFixed(2),
    /** The weighted expense ratio of the priced positions, in percent. */
    weighted_expense_ratio: priced.gt(0) ? yearly.div(priced).times(100).toFixed(3) : null,
    priced_share: total.gt(0) ? priced.div(total).times(100).toFixed(1) : null,
    source: "SEC Mutual Fund Prospectus Risk/Return Summary data sets",
  };
}

export interface CardTermsFact {
  institution: string;
  product: string;
  report_date: string;
  national: boolean;
  secured: boolean;
  annual_fee: string | null;
  purchase_apr_min: string | null;
  purchase_apr_median: string | null;
  purchase_apr_max: string | null;
  intro_apr: boolean;
  foreign_transaction_fee: string | null;
  rewards: string | null;
  credit_tiers: string | null;
  website: string | null;
  source_url: string;
}

/** Cards in the CFPB's survey whose issuer or name contains every word of `query`. */
export async function searchCardTerms(
  db: AgentDb,
  query: string,
  limit = 20,
): Promise<CardTermsFact[]> {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2)
    .slice(0, 6);
  if (words.length === 0) return [];
  const { rows } = await db.query<CardTermsFact>(
    `select institution, product, report_date, national, secured, annual_fee::text,
       purchase_apr_min::text, purchase_apr_median::text, purchase_apr_max::text, intro_apr,
       foreign_transaction_fee::text, rewards, credit_tiers, website, source_url
     from card_terms
     where (select bool_and(lower(institution || ' ' || product) like '%' || w || '%')
            from unnest($1::text[]) w)
     order by national desc, institution, product
     limit $2`,
    [words, limit],
  );
  return rows;
}

/** The whole CFPB survey, for matching catalog cards against it. */
export async function readCardSurvey(db: AgentDb): Promise<CardTermsFact[]> {
  const { rows } = await db.query<CardTermsFact>(
    `select institution, product, report_date, national, secured, annual_fee::text,
       purchase_apr_min::text, purchase_apr_median::text, purchase_apr_max::text, intro_apr,
       foreign_transaction_fee::text, rewards, credit_tiers, website, source_url
     from card_terms`,
  );
  return rows;
}

/**
 * The latest short government bill yield where the session user lives: a neutral yardstick for
 * what cash can earn. The US Treasury's 13-week bill, or the Government of Canada's 3-month bill;
 * null elsewhere until a source is added there.
 */
export async function readTreasuryBenchmark(db: AgentDb) {
  const { country } = await readAgentRegion(db);
  const series = country === "CA" ? CANADA_TBILL_SERIES : country === "US" ? TREASURY_SERIES : null;
  if (!series) return null;
  const { rows } = await db.query<{ day: string; value: string }>(
    `select day, value::text from market_reading where series = $1 order by day desc limit 1`,
    [series],
  );
  const r = rows[0];
  if (!r) return null;
  if (country === "CA") {
    return {
      name: "3-month Government of Canada treasury bill yield",
      yield: new Big(r.value).toFixed(2),
      as_of: r.day,
      source_url: "https://www.bankofcanada.ca/rates/interest-rates/t-bill-yields/",
      note:
        "What lending to the Government of Canada for three months pays (average yield at its " +
        "latest auction, from the Bank of Canada). A yardstick, not a bank account: compare cash " +
        "rates with it.",
    };
  }
  return {
    name: "13-week (3-month) US Treasury bill yield",
    yield: new Big(r.value).toFixed(2),
    as_of: r.day,
    source_url:
      "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_bill_rates",
    note:
      "What lending to the US government for three months pays (coupon-equivalent yield, the " +
      "figure comparable to an APY); Treasury interest is free of state income tax. A yardstick, " +
      "not a bank account: compare cash rates with it.",
  };
}

/** When each public source last imported something, and its last failure since then. */
export async function readFactSources(db: AgentDb) {
  const { rows } = await db.query<{
    source: string;
    last_ok: string | null;
    last_file: string | null;
    last_error: string | null;
  }>(
    `select s.source,
       (select max(at)::text from fact_import where source = s.source and ok) as last_ok,
       (select file from fact_import where source = s.source and ok and file is not null
         order by at desc limit 1) as last_file,
       (select error from fact_import f where f.source = s.source and not ok
          and f.at > coalesce((select max(at) from fact_import where source = s.source and ok), '-infinity')
         order by at desc limit 1) as last_error
     from (values ('sec_funds'), ('cfpb_cards'), ('treasury'), ('bank_of_canada')) s(source)`,
  );
  return rows;
}

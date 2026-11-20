import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { cardTerms, factImport, fundFee } from "../db/schema.js";
import { type Reading, recordReadings } from "../market/calm.js";
import { CFPB_TCCP_PAGE, fetchSurvey } from "./cfpbCards.js";
import { fetchDataSet, fetchDataSetPage, filesToImport } from "./secFunds.js";

// Public product facts, fetched on the owner side (`tidysum facts refresh`, and `serve` once a
// day): fund fees from the SEC, card fees and APRs from the CFPB, and the 13-week Treasury bill yield
// as a neutral benchmark for cash, plus the Bank of Canada's 3-month bill yield for users in
// Canada. All are government data, free to use, with no key and no referral money behind them.
// Each source fails on its own and is logged in fact_import.

/** The 13-week Treasury bill's coupon-equivalent yield, in market_reading. */
export const TREASURY_SERIES = "TBILL13W";

/** The Government of Canada 3-month treasury bill's average auction yield, in market_reading. */
export const CANADA_TBILL_SERIES = "CA_TBILL3M";

export type FactSource = "sec_funds" | "cfpb_cards" | "treasury" | "bank_of_canada";

/** How often each source is worth fetching: the SEC adds a file a month, the CFPB two a year. */
const EVERY_HOURS: Record<FactSource, number> = {
  sec_funds: 24 * 7,
  cfpb_cards: 24 * 7,
  treasury: 12,
  // Auctions are every other week.
  bank_of_canada: 24,
};

export interface Fetchers {
  sec?: typeof fetch;
  cfpb?: typeof fetch;
  treasury?: typeof fetch;
  bankOfCanada?: typeof fetch;
}

export interface RefreshResult {
  source: FactSource;
  /** skipped: fetched recently enough. */
  status: "imported" | "nothing_new" | "skipped" | "failed";
  files: string[];
  rows: number;
  error?: string;
}

async function log(
  db: Db,
  at: Date,
  source: FactSource,
  ok: boolean,
  rows: number,
  file?: string,
  error?: string,
) {
  await db
    .insert(factImport)
    .values({ source, ok, rows, at, file: file ?? null, error: error ?? null });
}

/** A failed fetch is tried again after this many hours, not a whole week later. */
const RETRY_HOURS = 6;

async function lastTry(db: Db, source: FactSource, ok: boolean): Promise<Date | null> {
  const [r] = await db
    .select({ at: factImport.at })
    .from(factImport)
    .where(and(eq(factImport.source, source), eq(factImport.ok, ok)))
    .orderBy(desc(factImport.at))
    .limit(1);
  return r?.at ?? null;
}

async function importedFiles(db: Db, source: FactSource): Promise<string[]> {
  const rows = await db
    .selectDistinct({ file: factImport.file })
    .from(factImport)
    .where(and(eq(factImport.source, source), eq(factImport.ok, true)));
  return rows.flatMap((r) => (r.file ? [r.file] : []));
}

const errorOf = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

async function refreshFunds(
  db: Db,
  at: Date,
  today: string,
  fetcher?: typeof fetch,
): Promise<RefreshResult> {
  const files = filesToImport(
    await fetchDataSetPage(fetcher),
    await importedFiles(db, "sec_funds"),
    today,
  );
  const out: RefreshResult = { source: "sec_funds", status: "nothing_new", files: [], rows: 0 };
  for (const f of files) {
    const rows = await fetchDataSet(f, fetcher);
    const values = rows.map((r) => ({
      classId: r.class_id,
      seriesId: r.series_id,
      ticker: r.ticker,
      fundName: r.fund_name,
      className: r.class_name,
      expenseRatio: r.expense_ratio,
      grossExpenseRatio: r.gross_expense_ratio,
      asOf: r.as_of,
      filed: r.filed,
      sourceUrl: r.source_url,
    }));
    await db.transaction(async (tx) => {
      for (let i = 0; i < values.length; i += 1000) {
        await tx
          .insert(fundFee)
          .values(values.slice(i, i + 1000))
          .onConflictDoUpdate({
            target: fundFee.classId,
            set: {
              seriesId: sql`excluded.series_id`,
              ticker: sql`excluded.ticker`,
              fundName: sql`excluded.fund_name`,
              className: sql`excluded.class_name`,
              expenseRatio: sql`excluded.expense_ratio`,
              grossExpenseRatio: sql`excluded.gross_expense_ratio`,
              asOf: sql`excluded.as_of`,
              filed: sql`excluded.filed`,
              sourceUrl: sql`excluded.source_url`,
              updatedAt: sql`now()`,
            },
            // An older file never overwrites a newer filing's fee.
            setWhere: sql`excluded.filed >= ${fundFee.filed}`,
          });
      }
      await tx
        .insert(factImport)
        .values({ source: "sec_funds", ok: true, rows: rows.length, file: f.name, at });
    });
    out.status = "imported";
    out.files.push(f.name);
    out.rows += rows.length;
  }
  if (out.status === "nothing_new") await log(db, at, "sec_funds", true, 0);
  return out;
}

async function refreshCards(db: Db, at: Date, fetcher?: typeof fetch): Promise<RefreshResult> {
  const survey = await fetchSurvey(fetcher);
  if ((await importedFiles(db, "cfpb_cards")).includes(survey.file)) {
    await log(db, at, "cfpb_cards", true, 0);
    return { source: "cfpb_cards", status: "nothing_new", files: [], rows: 0 };
  }
  await db.transaction(async (tx) => {
    await tx.delete(cardTerms);
    const values = survey.cards.map((c) => ({
      institution: c.institution,
      product: c.product,
      reportDate: c.report_date,
      national: c.national,
      secured: c.secured,
      annualFee: c.annual_fee,
      purchaseAprMin: c.purchase_apr_min,
      purchaseAprMedian: c.purchase_apr_median,
      purchaseAprMax: c.purchase_apr_max,
      introApr: c.intro_apr,
      foreignTransactionFee: c.foreign_transaction_fee,
      rewards: c.rewards,
      creditTiers: c.credit_tiers,
      website: c.website,
      sourceUrl: CFPB_TCCP_PAGE,
    }));
    for (let i = 0; i < values.length; i += 500)
      await tx.insert(cardTerms).values(values.slice(i, i + 500));
    await tx
      .insert(factImport)
      .values({ source: "cfpb_cards", ok: true, rows: values.length, file: survey.file, at });
  });
  return {
    source: "cfpb_cards",
    status: "imported",
    files: [survey.file],
    rows: survey.cards.length,
  };
}

const TREASURY_CSV =
  "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv";

/**
 * The Treasury's daily bill rates CSV ("Date,...,13 WEEKS COUPON EQUIVALENT,..." then
 * "11/19/2026,...,4.26,..."): the 13-week bill's coupon-equivalent yield, the figure comparable to
 * a bank's APY.
 */
export function parseBillRates(csv: string): Reading[] {
  const [head, ...lines] = csv.split(/\r?\n/);
  const cols = (head ?? "").split(",").map((c) => c.replace(/"/g, "").trim().toUpperCase());
  const at = cols.indexOf("13 WEEKS COUPON EQUIVALENT");
  if (at < 0) return [];
  const out: Reading[] = [];
  for (const line of lines) {
    const cells = line.split(",").map((c) => c.replace(/"/g, "").trim());
    const date = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(cells[0] ?? "");
    const value = cells[at] ?? "";
    if (!date || !/^\d{1,2}(\.\d{1,4})?$/.test(value)) continue;
    out.push({ day: `${date[3]}-${date[1]}-${date[2]}`, value });
  }
  return out;
}

async function refreshTreasury(
  db: Db,
  at: Date,
  today: string,
  fetcher: typeof fetch = fetch,
): Promise<RefreshResult> {
  const year = Number(today.slice(0, 4));
  const rows: Reading[] = [];
  // Early in January the new year's file may still be empty, so last year's is read too.
  for (const y of today.slice(5, 7) === "01" ? [year - 1, year] : [year]) {
    const res = await fetcher(
      `${TREASURY_CSV}/${y}/all?type=daily_treasury_bill_rates&field_tdr_date_value=${y}&page&_format=csv`,
      { headers: { "user-agent": "tidysum" }, signal: AbortSignal.timeout(30_000) },
    );
    if (!res.ok) throw new Error(`Treasury bill rates ${y}: HTTP ${res.status}`);
    rows.push(...parseBillRates(await res.text()).filter((r) => r.day <= today));
  }
  const recent = rows.sort((a, b) => a.day.localeCompare(b.day)).slice(-30);
  const n = await recordReadings(db, TREASURY_SERIES, recent);
  await log(db, at, "treasury", true, n);
  return { source: "treasury", status: n ? "imported" : "nothing_new", files: [], rows: n };
}

/** The Bank of Canada's Valet series for the 3-month bill's average auction yield. */
const BOC_SERIES = "V80691303";
export const BOC_VALET = `https://www.bankofcanada.ca/valet/observations/${BOC_SERIES}/json`;

/**
 * Valet's JSON (`{"observations":[{"d":"2026-11-17","V80691303":{"v":"2.66"}}]}`) as readings.
 */
export function parseValet(json: unknown): Reading[] {
  const obs = (json as { observations?: unknown })?.observations;
  if (!Array.isArray(obs)) return [];
  return obs.flatMap((o): Reading[] => {
    const day = (o as { d?: unknown })?.d;
    const value = (o as Record<string, { v?: unknown } | undefined>)?.[BOC_SERIES]?.v;
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
    if (typeof value !== "string" || !/^\d{1,2}(\.\d{1,4})?$/.test(value)) return [];
    return [{ day, value }];
  });
}

async function refreshBankOfCanada(
  db: Db,
  at: Date,
  today: string,
  fetcher: typeof fetch = fetch,
): Promise<RefreshResult> {
  const res = await fetcher(`${BOC_VALET}?recent=10`, {
    headers: { "user-agent": "tidysum" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Bank of Canada bill yields: HTTP ${res.status}`);
  const rows = parseValet(await res.json()).filter((r) => r.day <= today);
  const n = await recordReadings(db, CANADA_TBILL_SERIES, rows);
  await log(db, at, "bank_of_canada", true, n);
  return { source: "bank_of_canada", status: n ? "imported" : "nothing_new", files: [], rows: n };
}

/**
 * Fetches each public source that is due (or every one, with `force`). One failing source doesn't
 * stop the others; its error is logged and returned.
 */
export async function refreshFacts(
  db: Db,
  today: string,
  opts: { force?: boolean; fetchers?: Fetchers; now?: Date; only?: FactSource[] } = {},
): Promise<RefreshResult[]> {
  const now = opts.now ?? new Date();
  const run: Record<FactSource, () => Promise<RefreshResult>> = {
    sec_funds: () => refreshFunds(db, now, today, opts.fetchers?.sec),
    cfpb_cards: () => refreshCards(db, now, opts.fetchers?.cfpb),
    treasury: () => refreshTreasury(db, now, today, opts.fetchers?.treasury),
    bank_of_canada: () => refreshBankOfCanada(db, now, today, opts.fetchers?.bankOfCanada),
  };
  const results: RefreshResult[] = [];
  for (const source of opts.only ?? (Object.keys(run) as FactSource[])) {
    const ok = await lastTry(db, source, true);
    const failed = await lastTry(db, source, false);
    const within = (at: Date | null, hours: number) =>
      at !== null && now.getTime() - at.getTime() < hours * 3_600_000;
    if (!opts.force && (within(ok, EVERY_HOURS[source]) || within(failed, RETRY_HOURS))) {
      results.push({ source, status: "skipped", files: [], rows: 0 });
      continue;
    }
    try {
      results.push(await run[source]());
    } catch (err) {
      await log(db, now, source, false, 0, undefined, errorOf(err));
      results.push({ source, status: "failed", files: [], rows: 0, error: errorOf(err) });
    }
  }
  return results;
}

import Big from "big.js";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { marketReading } from "../db/schema.js";
import type { AgentDb } from "../mcp/agentDb.js";

// Calm markets (decision 0008). An action that sells and buys back can wait until markets are
// quiet, so the money that sits out of the market for a few days does so in a calm stretch. Calm
// is read off the VIX: at or below CALM_VIX, about its long-run average, for the last CALM_CLOSES
// closes, with no close above SPIKE_VIX in the last LOOKBACK closes (a spike's aftershocks come in
// the weeks after it), the newest no older than a few days. Closes come from FRED (series VIXCLS,
// free, no key), which has them a day late, and today's level from Cboe's delayed quote, every
// hour while `tidysum serve` runs, so a jumpy day counts the same day.

export const VIX_SERIES = "VIXCLS";
/** The VIX close at or below which markets count as calm: about its long-run average. */
export const CALM_VIX = "20";
/** How many closes in a row have to be calm, so a few quiet days aren't mistaken for calm. */
export const CALM_CLOSES = 5;
/** A close above this in the last LOOKBACK closes is a recent spike: not calm yet. */
export const SPIKE_VIX = "25";
/** About three weeks of trading days. */
export const LOOKBACK = 15;
/** A newest reading older than this many days (a long weekend at most) is too old to go by. */
const FRESH_DAYS = 4;

const FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv";
const CBOE_QUOTE_URL = "https://cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json";

export interface Reading {
  day: string;
  value: string;
}

/** FRED's CSV ("observation_date,VIXCLS" then "2026-11-13,17.25"); "." marks a missing day. */
export function parseFredCsv(text: string): Reading[] {
  const out: Reading[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const [day, value] = line.split(",").map((s) => s.trim());
    if (!day || !value || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (!/^\d{1,4}(\.\d{1,4})?$/.test(value)) continue;
    out.push({ day, value });
  }
  return out;
}

/** The last month of VIX closes from FRED. */
export async function fetchVix(today: string, fetcher: typeof fetch = fetch): Promise<Reading[]> {
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 31 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const res = await fetcher(`${FRED_URL}?id=${VIX_SERIES}&cosd=${from}`, {
    headers: { "user-agent": "tidysum" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`FRED ${VIX_SERIES}: HTTP ${res.status}`);
  return parseFredCsv(await res.text());
}

/**
 * Today's VIX from Cboe's delayed quote: the latest level and the day it's for (US Eastern). During
 * trading hours it's the level so far, and after 4:15 PM Eastern the day's close.
 */
export async function fetchVixQuote(fetcher: typeof fetch = fetch): Promise<Reading | null> {
  const res = await fetcher(CBOE_QUOTE_URL, {
    headers: { "user-agent": "Mozilla/5.0 (tidysum)", accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Cboe VIX quote: HTTP ${res.status}`);
  return parseCboeQuote(await res.json());
}

export function parseCboeQuote(body: unknown): Reading | null {
  const data = (body as { data?: { current_price?: unknown; last_trade_time?: unknown } } | null)
    ?.data;
  const price = data?.current_price;
  const at = data?.last_trade_time;
  if (typeof at !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(at)) return null;
  const value = typeof price === "number" ? String(price) : typeof price === "string" ? price : "";
  if (!/^\d{1,4}(\.\d{1,6})?$/.test(value)) return null;
  return { day: at.slice(0, 10), value: new Big(value).toFixed(4) };
}

export async function recordReadings(
  db: Db,
  series: string,
  rows: Reading[],
  now: Date = new Date(),
): Promise<number> {
  if (rows.length === 0) return 0;
  await db
    .insert(marketReading)
    .values(rows.map((r) => ({ series, day: r.day, value: r.value, fetchedAt: now })))
    .onConflictDoUpdate({
      target: [marketReading.series, marketReading.day],
      set: { value: sql`excluded.value`, fetchedAt: now },
    });
  return rows.length;
}

/** How long FRED's closes last: it adds each close the next morning, so twice a day is plenty. */
const REFETCH_MS = 12 * 3_600_000;

/**
 * Records the VIX: FRED's last month of closes at most every twelve hours, and Cboe's quote for
 * today each time, so a jumpy day counts before FRED has it. Either can fail on its own.
 */
export async function refreshVix(
  db: Db,
  today: string,
  fetchers: { fred?: typeof fetch; cboe?: typeof fetch } = {},
  now: Date = new Date(),
): Promise<number> {
  const errors: string[] = [];
  let n = 0;
  const [last] = await db
    .select({ at: sql<Date | null>`max(${marketReading.fetchedAt})` })
    .from(marketReading)
    .where(sql`${marketReading.series} = ${VIX_SERIES} and ${marketReading.day} < ${today}::date`);
  const at = last?.at ? new Date(last.at) : null;
  if (!at || now.getTime() - at.getTime() >= REFETCH_MS) {
    try {
      // Only past days: FRED doesn't have today, and the quote for today shouldn't be undone.
      const rows = (await fetchVix(today, fetchers.fred)).filter((r) => r.day < today);
      n += await recordReadings(db, VIX_SERIES, rows, now);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  try {
    const quote = await fetchVixQuote(fetchers.cboe);
    if (quote && quote.day <= today) n += await recordReadings(db, VIX_SERIES, [quote], now);
  } catch (err) {
    errors.push((err as Error).message);
  }
  if (errors.length) throw new Error(errors.join("; "));
  return n;
}

export interface Calm {
  calm: boolean;
  /** The newest VIX reading and its day, or null before any is recorded. */
  vix: string | null;
  as_of: string | null;
  threshold: string;
  /** The highest close in the last LOOKBACK closes, and the limit it has to stay under. */
  peak: string | null;
  spike: string;
}

/** Whether markets are calm by the given closes, newest last. */
export function calmFrom(closes: Reading[], today: string): Calm {
  const lookback = closes.slice(-LOOKBACK);
  const recent = closes.slice(-CALM_CLOSES);
  const newest = recent.at(-1) ?? null;
  const fresh =
    !!newest &&
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${newest.day}T00:00:00Z`)) / 86_400_000 <=
      FRESH_DAYS;
  const peak = lookback.reduce<Big | null>(
    (m, r) => (m === null || new Big(r.value).gt(m) ? new Big(r.value) : m),
    null,
  );
  return {
    calm:
      fresh &&
      lookback.length === LOOKBACK &&
      recent.every((r) => new Big(r.value).lte(CALM_VIX)) &&
      !!peak &&
      peak.lte(SPIKE_VIX),
    vix: newest?.value ?? null,
    as_of: newest?.day ?? null,
    threshold: CALM_VIX,
    peak: peak ? peak.toFixed(2) : null,
    spike: SPIKE_VIX,
  };
}

/** Whether markets are calm now, from the recorded closes. Runs as tidysum_agent. */
export async function readCalm(db: AgentDb, today: string): Promise<Calm> {
  const { rows } = await db.query<Reading>(
    `select day::text as day, value::text as value from market_reading
      where series = $1 and day <= $2::date order by day desc limit ${LOOKBACK}`,
    [VIX_SERIES, today],
  );
  return calmFrom(rows.reverse(), today);
}

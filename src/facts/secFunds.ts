import Big from "big.js";
import { unzipFile } from "./zip.js";

// What mutual funds and ETFs charge, from the SEC's Mutual Fund Prospectus Risk/Return Summary
// data sets: every open-end fund's prospectus fee table, tagged in XBRL and published as flat
// files, monthly. US government data, free to use and to ship. Funds refile their prospectus
// once a year, so the last year of files covers essentially every fund with a ticker.

export const SEC_RR_PAGE =
  "https://www.sec.gov/data-research/sec-markets-data/mutual-fund-prospectus-riskreturn-summary-data-sets";
const SEC_ORIGIN = "https://www.sec.gov";

/**
 * The SEC refuses requests that don't name who is asking. Self-hosters can name themselves;
 * by default requests name the Tidysum project's public contact.
 */
export const secUserAgent = (env = process.env) =>
  env.TIDYSUM_SEC_USER_AGENT || "Tidysum hello.tidysum@proton.me";

/** One share class's fee, as its latest prospectus in the data states it. */
export interface FundFee {
  class_id: string;
  series_id: string;
  ticker: string;
  fund_name: string;
  class_name: string | null;
  /** Percent a year after any fee waiver, like "0.03": what holders pay. */
  expense_ratio: string;
  /** Percent before waivers, when the fee table states one apart. */
  gross_expense_ratio: string | null;
  /** The date the prospectus's fee table is as of. */
  as_of: string;
  /** When the filing reached the SEC. */
  filed: string;
  /** The filing on EDGAR. */
  source_url: string;
}

/** A data set file on the SEC's page, with the months its filings came in. */
export interface DataSetFile {
  /** e.g. 2026-10_rr1.zip, 2026q3_rr1.zip or 2023_rr1.zip */
  name: string;
  url: string;
  months: string[];
}

function monthsOf(stem: string): string[] | null {
  let m = /^(\d{4})-(\d{2})$/.exec(stem);
  if (m) return [`${m[1]}-${m[2]}`];
  m = /^(\d{4})q([1-4])$/.exec(stem);
  if (m) {
    const first = (Number(m[2]) - 1) * 3 + 1;
    return [0, 1, 2].map((i) => `${m?.[1]}-${String(first + i).padStart(2, "0")}`);
  }
  m = /^(\d{4})$/.exec(stem);
  if (m) return Array.from({ length: 12 }, (_, i) => `${m?.[1]}-${String(i + 1).padStart(2, "0")}`);
  return null;
}

/** The data set files the SEC's page links to, newest first as the page lists them. */
export function parseDataSetPage(html: string): DataSetFile[] {
  const out: DataSetFile[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/href="([^"]*\/((\d{4}(?:-\d{2}|q[1-4])?)_rr1\.zip))"/g)) {
    const [, href, name, stem] = m;
    if (!href || !name || !stem || seen.has(name)) continue;
    const months = monthsOf(stem);
    if (!months) continue;
    seen.add(name);
    out.push({ name, url: new URL(href, SEC_ORIGIN).toString(), months });
  }
  return out;
}

/**
 * The files to import: those with filings from the last `window` months whose months aren't all
 * covered by files already imported (a quarter's file repeats its three monthly files).
 */
export function filesToImport(
  files: DataSetFile[],
  imported: string[],
  today: string,
  window = 13,
): DataSetFile[] {
  const [y, mo] = today.split("-").map(Number);
  const start = new Date(Date.UTC(y ?? 1970, (mo ?? 1) - 1 - window, 1)).toISOString().slice(0, 7);
  const covered = new Set(files.filter((f) => imported.includes(f.name)).flatMap((f) => f.months));
  const out: DataSetFile[] = [];
  for (const f of files) {
    if (imported.includes(f.name)) continue;
    const recent = f.months.filter((m) => m >= start);
    if (recent.length === 0 || recent.every((m) => covered.has(m))) continue;
    out.push(f);
    for (const m of f.months) covered.add(m);
  }
  return out;
}

/** Rows of a tab-separated file, keyed by its header. */
function* tsv(text: string): Generator<Record<string, string>> {
  let header: string[] | null = null;
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).replace(/\r$/, "");
    start = end + 1;
    if (!line) continue;
    const cells = line.split("\t");
    if (!header) {
      header = cells;
      continue;
    }
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) row[header[i] ?? ""] = cells[i] ?? "";
    yield row;
  }
}

const isoOf = (yyyymmdd: string) =>
  /^\d{8}$/.test(yyyymmdd)
    ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
    : null;

/** A fee fraction ("0.0003") as a percent ("0.03"); null when it isn't a sane fee. */
function percentOf(fraction: string): string | null {
  if (!/^\d(\.\d{1,8})?$/.test(fraction)) return null;
  const p = new Big(fraction).times(100);
  return p.gte(0) && p.lt(10) ? p.round(4).toString() : null;
}

/** Only the fund and class dimensions, so a fee for one scenario or document part is left out. */
const PLAIN_DIMS = new Set(["Class", "LegalEntity", "DocumentInformationDocument"]);
const plain = (otherdims: string) =>
  otherdims
    .split(";")
    .filter(Boolean)
    .every((d) => PLAIN_DIMS.has(d.split("=")[0] ?? ""));

/** Every share class with a ticker and a stated fee in one data set file. */
export function parseDataSet(zip: Buffer): FundFee[] {
  const read = (name: string) => {
    const b = unzipFile(zip, name);
    if (!b) throw new Error(`the data set has no ${name}`);
    return b.toString("utf8");
  };
  const filings = new Map<string, { cik: string; filed: string }>();
  for (const r of tsv(read("sub.tsv"))) {
    const filed = isoOf(r.filed ?? "");
    if (r.adsh && r.cik && filed) filings.set(r.adsh, { cik: r.cik, filed });
  }
  const classes = new Map<
    string,
    { series_id: string; fund: string; name: string; ticker: string }
  >();
  for (const r of tsv(read("scn.tsv"))) {
    const ticker = r.ticker?.trim().toUpperCase();
    if (!r.classid || !ticker || !/^[A-Z0-9.-]{1,12}$/.test(ticker)) continue;
    classes.set(`${r.adsh}|${r.classid}`, {
      series_id: r.seriesid ?? "",
      fund: r.seriesname ?? "",
      name: r.classname ?? "",
      ticker,
    });
  }
  /** Per filing and class: the fee before and after waivers. */
  const fees = new Map<string, { gross?: string; net?: string; as_of: string }>();
  for (const r of tsv(read("num.tsv"))) {
    if (r.tag !== "ExpensesOverAssets" && r.tag !== "NetExpensesOverAssets") continue;
    if (!r.class || r.iprx !== "0" || r.measure || !plain(r.otherdims ?? "")) continue;
    const key = `${r.adsh}|${r.class}`;
    const as_of = isoOf(r.ddate ?? "");
    const value = percentOf(r.value ?? "");
    if (!classes.has(key) || !as_of || value === null) continue;
    const f = fees.get(key) ?? { as_of };
    if (r.tag === "ExpensesOverAssets") f.gross ??= value;
    else f.net ??= value;
    fees.set(key, f);
  }
  const best = new Map<string, FundFee>();
  for (const [key, f] of fees) {
    const [adsh = "", classId = ""] = key.split("|");
    const c = classes.get(key);
    const filing = filings.get(adsh);
    const ratio = f.net ?? f.gross;
    if (!c || !filing || ratio === undefined) continue;
    const row: FundFee = {
      class_id: classId,
      series_id: c.series_id,
      ticker: c.ticker,
      fund_name: c.fund,
      class_name: c.name || null,
      expense_ratio: ratio,
      gross_expense_ratio: f.net !== undefined && f.gross !== undefined ? f.gross : null,
      as_of: f.as_of,
      filed: filing.filed,
      source_url: `${SEC_ORIGIN}/Archives/edgar/data/${filing.cik}/${adsh.replace(/-/g, "")}/${adsh}-index.htm`,
    };
    const prev = best.get(classId);
    if (!prev || row.filed > prev.filed || (row.filed === prev.filed && row.as_of > prev.as_of)) {
      best.set(classId, row);
    }
  }
  return [...best.values()];
}

async function get(url: string, fetcher: typeof fetch, env = process.env): Promise<Response> {
  const res = await fetcher(url, {
    headers: { "user-agent": secUserAgent(env) },
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`SEC ${url}: HTTP ${res.status}`);
  return res;
}

export async function fetchDataSetPage(fetcher: typeof fetch = fetch): Promise<DataSetFile[]> {
  const files = parseDataSetPage(await (await get(SEC_RR_PAGE, fetcher)).text());
  if (files.length === 0) throw new Error("the SEC's data set page lists no files");
  return files;
}

export async function fetchDataSet(file: DataSetFile, fetcher: typeof fetch = fetch) {
  return parseDataSet(Buffer.from(await (await get(file.url, fetcher)).arrayBuffer()));
}

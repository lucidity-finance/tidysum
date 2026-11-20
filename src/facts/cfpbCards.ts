import Big from "big.js";
import { readFirstSheet } from "./xlsx.js";

// Card fees and APRs from the CFPB's Terms of Credit Card Plans survey: twice a year, issuers
// report every card they offer (well over 600 from 150+ issuers). US government data, free to
// use and to ship. It states fees and rates, not reward rates: rewards appear only as a type
// ("Cashback rewards"), so the card catalog still holds what cards earn.

export const CFPB_TCCP_PAGE =
  "https://www.consumerfinance.gov/data-research/credit-card-data/terms-credit-card-plans-survey/";

export interface CardTerms {
  institution: string;
  product: string;
  /** The last day of the survey period the terms are as of. */
  report_date: string;
  national: boolean;
  secured: boolean;
  /** Dollars a year; null when the card charges none (or only another kind of fee). */
  annual_fee: string | null;
  /** Percent APRs on purchases: lowest, median and highest the issuer reported. */
  purchase_apr_min: string | null;
  purchase_apr_median: string | null;
  purchase_apr_max: string | null;
  intro_apr: boolean;
  /** Percent of each foreign purchase; "0" when the card charges none. */
  foreign_transaction_fee: string | null;
  /** The kinds of rewards, as the issuer described them; never reward rates. */
  rewards: string | null;
  credit_tiers: string | null;
  website: string | null;
}

/** The newest survey file the CFPB's page links to. */
export function latestSurveyUrl(html: string): string | null {
  return (
    /https:\/\/files\.consumerfinance\.gov\/f\/documents\/cfpb_tccp-data_[^"'\s]+\.xlsx/.exec(
      html,
    )?.[0] ?? null
  );
}

/** A fraction ("0.2749") as a percent rounded to hundredths ("27.49"). */
function percentOf(v: string | undefined): string | null {
  if (!v || !/^\d+(\.\d+)?(E-?\d+)?$/i.test(v.trim())) return null;
  const p = new Big(v.trim()).times(100);
  return p.lt(100) ? p.toFixed(2) : null;
}

function dollarsOf(v: string | undefined): string | null {
  if (!v || !/^\d+(\.\d+)?$/.test(v.trim())) return null;
  return new Big(v.trim()).toFixed(2);
}

const text = (v: string | undefined) => {
  const t = v?.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 300) : null;
};

export function parseSurvey(xlsx: Buffer): CardTerms[] {
  const rows = readFirstSheet(xlsx);
  const headerAt = rows.findIndex(
    (r) => r.includes("Institution Name") && r.includes("Product Name"),
  );
  if (headerAt < 0) throw new Error("the survey file has no header row");
  const header = rows[headerAt] ?? [];
  const col = (name: string) => header.indexOf(name);
  const need = ["Institution Name", "Product Name", "Report Date", "Annual Fee"];
  for (const n of need) if (col(n) < 0) throw new Error(`the survey file has no ${n} column`);
  const out: CardTerms[] = [];
  for (const r of rows.slice(headerAt + 1)) {
    const get = (name: string) => {
      const i = col(name);
      return i < 0 ? undefined : r[i];
    };
    const institution = text(get("Institution Name"));
    const product = text(get("Product Name"));
    const report_date = /\d{4}-\d{2}-\d{2}/.exec(get("Report Date") ?? "")?.[0];
    if (!institution || !product || !report_date) continue;
    const fxCharged = get("Foreign Transaction Fees?") === "Yes";
    out.push({
      institution,
      product,
      report_date,
      national: get("Availability of Credit Card Plan") === "National",
      secured: get("Secured Card") === "Yes",
      annual_fee: dollarsOf(get("Annual Fee")),
      purchase_apr_min: percentOf(get("Purchase APR min") || get("Purchase APR Balance Tier 1")),
      purchase_apr_median: percentOf(
        get("Purchase APR median") || get("Purchase APR Balance Tier 1"),
      ),
      purchase_apr_max: percentOf(get("Purchase APR max") || get("Purchase APR Balance Tier 1")),
      intro_apr: get("Introductory APR Offered?") === "Yes",
      foreign_transaction_fee: fxCharged
        ? percentOf(get("Foreign Transaction Fee (%)"))
        : get("Foreign Transaction Fees?") === "No"
          ? "0"
          : null,
      rewards: text(get("Rewards")),
      credit_tiers: text(get("Targeted Credit Tiers")),
      website: text(get("Website for Consumer")),
    });
  }
  return out;
}

export async function fetchSurvey(
  fetcher: typeof fetch = fetch,
): Promise<{ file: string; url: string; cards: CardTerms[] }> {
  const headers = { "user-agent": "Mozilla/5.0 (Tidysum)" };
  const page = await fetcher(CFPB_TCCP_PAGE, { headers, signal: AbortSignal.timeout(60_000) });
  if (!page.ok) throw new Error(`CFPB survey page: HTTP ${page.status}`);
  const url = latestSurveyUrl(await page.text());
  if (!url) throw new Error("the CFPB's survey page links no data file");
  const res = await fetcher(url, { headers, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`CFPB survey file: HTTP ${res.status}`);
  const cards = parseSurvey(Buffer.from(await res.arrayBuffer()));
  if (cards.length === 0) throw new Error("the CFPB's survey file has no cards");
  return { file: url.split("/").pop() ?? url, url, cards };
}

import Big from "big.js";
import { z } from "zod";
import type { AgentDb } from "../mcp/agentDb.js";
import type { Card, CardCatalog } from "../products/cardCatalog.js";
import type { Catalog, Product } from "../products/catalog.js";
import { STALE_AFTER_DAYS } from "../products/compare.js";
import type { CardTermsFact } from "./read.js";

// Keeping the catalogs' rates current without a person re-reading every page. The owner's own
// agent opens a product's official page (list_stale_facts says which and where), and records
// what it found with submit_fact_check: still right, changed (the new values, with the sentence
// it quoted), or not found. Tidysum checks that the page is the provider's own and that the quote
// states each new number, then lays the check over the checked-in catalog: verified_on moves to
// the day of the check, and changed values replace the catalog's. A later catalog edit (a newer
// verified_on) wins over older checks. No referral feed or aggregator is ever the source.

const decimal = z.string().regex(/^\d{1,6}(\.\d{1,4})?$/, "must be a decimal string like 3.30");

export const DEPOSIT_FIELDS = ["apy", "conditional_apy", "monthly_fee"] as const;
export const CARD_FIELDS = ["annual_fee", "foreign_transaction_fee", "base_rate"] as const;

export const FactCheckInput = z
  .object({
    kind: z.enum(["deposit", "card"]),
    product_id: z.string().regex(/^[a-z0-9-]{1,60}$/),
    outcome: z.enum(["confirmed", "changed", "not_found"]),
    changes: z
      .partialRecord(z.enum([...DEPOSIT_FIELDS, ...CARD_FIELDS]), decimal)
      .optional()
      .describe("changed only: each field's new value"),
    source_url: z.url().refine((u) => u.startsWith("https://"), "must be https"),
    quote: z.string().min(10).max(1000),
    rates_as_of: z.iso.date().optional(),
  })
  .strict();
export type FactCheckInput = z.infer<typeof FactCheckInput>;

export interface FactCheck extends FactCheckInput {
  checked_on: string;
}

/** example.com for www.example.com and creditcards.example.com: the site a page belongs to. */
export function siteOf(url: string): string {
  const host = new URL(url).hostname.toLowerCase();
  return host.split(".").slice(-2).join(".");
}

/** Every number written in a quote: "3.30%", "$95", "1,000.00". */
function numbersIn(quote: string): Big[] {
  return [...quote.matchAll(/\d[\d,]*(?:\.\d+)?/g)].flatMap((m) => {
    const s = m[0].replace(/,/g, "");
    return /^\d+(\.\d+)?$/.test(s) ? [new Big(s)] : [];
  });
}

const NONE_PHRASES: Record<string, RegExp> = {
  annual_fee: /\bno annual fee\b/i,
  foreign_transaction_fee: /\bno foreign transaction fees?\b/i,
  monthly_fee: /\bno (monthly|account|maintenance) fees?\b/i,
};

/** Whether the quote states this value for this field. */
function quoteStates(quote: string, field: string, value: string): boolean {
  const v = new Big(value);
  if (numbersIn(quote).some((n) => n.eq(v))) return true;
  return v.eq(0) && (NONE_PHRASES[field]?.test(quote) ?? false);
}

function depositValues(p: Product): string[] {
  return [
    ...p.apy.map((t) => t.apy),
    ...(p.conditional_apy?.apy.map((t) => t.apy) ?? []),
    p.monthly_fee,
  ];
}

function cardValues(c: Card): string[] {
  return [
    c.annual_fee,
    ...(c.foreign_transaction_fee !== null ? [c.foreign_transaction_fee] : []),
    c.base_rate,
    ...c.rates.map((r) => r.rate),
    ...(c.choose_one?.rates.map((r) => r.rate) ?? []),
  ];
}

/**
 * Why a check can't be recorded, or null when it can. `deposits` and `cards` are the catalogs as
 * the owner's Tidysum loads them.
 */
export function factCheckProblem(
  input: FactCheckInput,
  deposits: Catalog | undefined,
  cards: CardCatalog | undefined,
  today: string,
): string | null {
  const product =
    input.kind === "deposit"
      ? deposits?.products.find((p) => p.id === input.product_id)
      : cards?.cards.find((c) => c.id === input.product_id);
  if (!product) return `no ${input.kind} product ${input.product_id} in the catalog`;
  if (siteOf(input.source_url) !== siteOf(product.source_url)) {
    return `source_url must be on the provider's own site (${siteOf(product.source_url)}), like ${product.source_url}`;
  }
  if (input.rates_as_of && input.rates_as_of > today) return "rates_as_of is in the future";
  const changes = Object.entries(input.changes ?? {});
  if (input.outcome !== "changed") {
    if (changes.length) return `${input.outcome} takes no changes`;
    if (input.outcome === "confirmed") {
      const current =
        input.kind === "deposit" ? depositValues(product as Product) : cardValues(product as Card);
      const fields = input.kind === "deposit" ? ["apy", "monthly_fee"] : CARD_FIELDS;
      if (!current.some((v) => fields.some((f) => quoteStates(input.quote, f, v)))) {
        return "the quote must state at least one of the product's current numbers (its rate or fee)";
      }
    }
    return null;
  }
  if (changes.length === 0) return "changed needs at least one field in changes";
  const allowed: readonly string[] = input.kind === "deposit" ? DEPOSIT_FIELDS : CARD_FIELDS;
  for (const [field, value] of changes) {
    if (!allowed.includes(field))
      return `${field} isn't a ${input.kind} field: use ${allowed.join(", ")}`;
    if (!quoteStates(input.quote, field, value)) {
      return `the quote must state the new ${field} (${value}) as written on the page`;
    }
    if (input.kind === "deposit") {
      const p = product as Product;
      if (field === "apy" && p.apy.length > 1) {
        return `${p.name} has balance tiers; a tiered rate change needs a catalog edit, not a fact check`;
      }
      if (field === "conditional_apy" && (!p.conditional_apy || p.conditional_apy.apy.length > 1)) {
        return `${p.name} has no single conditional rate to change`;
      }
      if ((field === "apy" || field === "conditional_apy") && new Big(value).gte(25)) {
        return `${field} ${value}% isn't a plausible deposit rate`;
      }
    } else if (field === "foreign_transaction_fee" && new Big(value).gte(10)) {
      return `foreign_transaction_fee ${value}% isn't plausible`;
    }
  }
  return null;
}

/** Checks, oldest first, as stored. */
export async function readFactChecks(db: AgentDb): Promise<FactCheck[]> {
  const { rows } = await db.query<{
    kind: "deposit" | "card";
    product_id: string;
    outcome: "confirmed" | "changed" | "not_found";
    changes: Record<string, string>;
    source_url: string;
    quote: string;
    rates_as_of: string | null;
    checked_on: string;
  }>(
    `select kind, product_id, outcome, changes, source_url, quote, rates_as_of, checked_on
     from fact_check order by at, id`,
  );
  return rows.map((r) => ({
    kind: r.kind,
    product_id: r.product_id,
    outcome: r.outcome,
    changes: r.changes,
    source_url: r.source_url,
    quote: r.quote,
    ...(r.rates_as_of ? { rates_as_of: r.rates_as_of } : {}),
    checked_on: r.checked_on,
  }));
}

/** Records a check as the proposer role, for its own user. */
export async function recordFactCheck(proposer: AgentDb, input: FactCheckInput, today: string) {
  await proposer.query(
    `insert into fact_check
       (kind, product_id, outcome, changes, source_url, quote, rates_as_of, checked_on, user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, tidysum_session_user())`,
    [
      input.kind,
      input.product_id,
      input.outcome,
      JSON.stringify(input.changes ?? {}),
      input.source_url,
      input.quote,
      input.rates_as_of ?? null,
      today,
    ],
  );
}

const singleTier = (apy: string) => [{ from: "0", apy }];

/** The deposit catalog with agents' checks laid over it. */
export function checkedDeposits(catalog: Catalog, checks: FactCheck[]): Catalog {
  return {
    ...catalog,
    products: catalog.products.map((p) => {
      let out = p;
      for (const c of checks) {
        if (c.kind !== "deposit" || c.product_id !== p.id || c.outcome === "not_found") continue;
        if (c.checked_on < out.verified_on) continue;
        const ch: Partial<Record<string, string>> = c.changes ?? {};
        out = {
          ...out,
          ...(ch.apy && out.apy.length === 1 ? { apy: singleTier(ch.apy) } : {}),
          ...(ch.conditional_apy && out.conditional_apy?.apy.length === 1
            ? { conditional_apy: { ...out.conditional_apy, apy: singleTier(ch.conditional_apy) } }
            : {}),
          ...(ch.monthly_fee ? { monthly_fee: ch.monthly_fee } : {}),
          ...(c.rates_as_of ? { rates_as_of: c.rates_as_of } : {}),
          verified_on: c.checked_on,
        };
      }
      return out;
    }),
  };
}

/** The card catalog with agents' checks laid over it. */
export function checkedCards(catalog: CardCatalog, checks: FactCheck[]): CardCatalog {
  return {
    ...catalog,
    cards: catalog.cards.map((card) => {
      let out = card;
      for (const c of checks) {
        if (c.kind !== "card" || c.product_id !== card.id || c.outcome === "not_found") continue;
        if (c.checked_on < out.verified_on) continue;
        const ch: Partial<Record<string, string>> = c.changes ?? {};
        out = {
          ...out,
          ...(ch.annual_fee ? { annual_fee: ch.annual_fee } : {}),
          ...(ch.foreign_transaction_fee
            ? { foreign_transaction_fee: ch.foreign_transaction_fee }
            : {}),
          ...(ch.base_rate ? { base_rate: ch.base_rate } : {}),
          verified_on: c.checked_on,
        };
      }
      return out;
    }),
  };
}

const DAY_MS = 86_400_000;
const ageOf = (verified: string, today: string) =>
  Math.round((Date.parse(today) - Date.parse(verified)) / DAY_MS);

/** Words that don't tell two cards apart: the issuer's own name, the network, "card". */
const FILLER = new Set([
  "card",
  "credit",
  "visa",
  "mastercard",
  "signature",
  "infinite",
  "world",
  "elite",
  "the",
  "from",
  "rewards",
  "amex",
]);

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[®™©]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** The CFPB survey row that is clearly this card (same issuer, same name), or null. */
export function surveyRowFor(card: Card, rows: CardTermsFact[]): CardTermsFact | null {
  const issuer = words(card.issuer).filter((w) => w.length > 2);
  const key = (name: string, extra: string[]) =>
    words(name)
      .filter((w) => !FILLER.has(w) && !issuer.includes(w) && !extra.includes(w))
      .join(" ");
  const want = key(card.name, []);
  if (!want) return null;
  const matches = rows.filter((r) => {
    const inst = words(r.institution);
    return (
      r.national &&
      issuer.some((w) => inst.some((i) => i.startsWith(w))) &&
      key(r.product, inst) === want
    );
  });
  const fees = new Set(matches.map((m) => `${m.annual_fee}|${m.foreign_transaction_fee}`));
  return matches.length > 0 && fees.size === 1 ? (matches[0] ?? null) : null;
}

export interface StaleFact {
  kind: "deposit" | "card";
  product_id: string;
  name: string;
  provider: string;
  /** Where to check: the provider's own page. */
  source_url: string;
  verified_on: string;
  age_days: number;
  /** Why it's listed: older than the limit, or the CFPB's survey states another fee. */
  reasons: string[];
  /** The values to check on the page, as the catalog (with past checks) has them now. */
  current: Record<string, string | null>;
  last_not_found?: string;
}

/**
 * Catalog products to re-check on the provider's own page: those verified more than 30 days ago,
 * and cards whose fees the CFPB's latest survey states differently (or states where the catalog
 * has none).
 */
export function staleFacts(
  deposits: Catalog | undefined,
  cards: CardCatalog | undefined,
  checks: FactCheck[],
  survey: CardTermsFact[],
  today: string,
): StaleFact[] {
  const notFound = new Map<string, string>();
  for (const c of checks) {
    if (c.outcome === "not_found") notFound.set(`${c.kind}:${c.product_id}`, c.checked_on);
  }
  const out: StaleFact[] = [];
  for (const p of deposits?.products ?? []) {
    const age = ageOf(p.verified_on, today);
    if (age <= STALE_AFTER_DAYS) continue;
    const nf = notFound.get(`deposit:${p.id}`);
    out.push({
      kind: "deposit",
      product_id: p.id,
      name: p.name,
      provider: p.provider,
      source_url: p.source_url,
      verified_on: p.verified_on,
      age_days: age,
      reasons: [`verified ${age} days ago`],
      current: {
        apy:
          p.apy.length === 1
            ? (p.apy[0]?.apy ?? null)
            : `tiered: ${p.apy.map((t) => `${t.apy}% from ${t.from}`).join(", ")}`,
        conditional_apy: p.conditional_apy
          ? `${p.conditional_apy.apy.map((t) => t.apy).join("/")} (requires ${p.conditional_apy.requires})`
          : null,
        monthly_fee: p.monthly_fee,
      },
      ...(nf && nf >= p.verified_on ? { last_not_found: nf } : {}),
    });
  }
  for (const c of cards?.cards ?? []) {
    const age = ageOf(c.verified_on, today);
    const reasons = age > STALE_AFTER_DAYS ? [`verified ${age} days ago`] : [];
    const row = surveyRowFor(c, survey);
    // Once an agent has looked at the page since the survey, the page has the last word.
    const looked = checks.some(
      (k) => k.kind === "card" && k.product_id === c.id && row && k.checked_on >= row.report_date,
    );
    if (row && !looked) {
      const said = `the CFPB's survey (as of ${row.report_date}) lists`;
      const fee = row.annual_fee ?? "0";
      if (!new Big(fee).eq(c.annual_fee)) reasons.push(`${said} an annual fee of $${fee}`);
      const fx = row.foreign_transaction_fee;
      if (
        fx !== null &&
        (c.foreign_transaction_fee === null || !new Big(fx).eq(c.foreign_transaction_fee))
      ) {
        reasons.push(`${said} a ${fx}% foreign transaction fee`);
      }
    }
    if (reasons.length === 0) continue;
    const nf = notFound.get(`card:${c.id}`);
    out.push({
      kind: "card",
      product_id: c.id,
      name: c.name,
      provider: c.issuer,
      source_url: c.source_url,
      verified_on: c.verified_on,
      age_days: age,
      reasons,
      current: {
        annual_fee: c.annual_fee,
        foreign_transaction_fee: c.foreign_transaction_fee,
        base_rate: c.base_rate,
      },
      ...(nf && nf >= c.verified_on ? { last_not_found: nf } : {}),
    });
  }
  return out.sort((a, b) => b.age_days - a.age_days || a.product_id.localeCompare(b.product_id));
}

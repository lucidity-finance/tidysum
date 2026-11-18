import { readFile } from "node:fs/promises";
import Big from "big.js";
import { z } from "zod";

// Credit cards Tidysum compares spending against. Like the deposit catalog, it is a checked-in
// file where every card carries the issuer page its terms came from and the date someone last
// checked that page. It holds no one's personal data, so any user's spending can be run
// against it.

const amount = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, "must be a decimal string like 95.00");
/** Points or percent per dollar, like "3" or "1.5". */
const rate = z.string().regex(/^\d{1,2}(\.\d{1,4})?$/, "must be a number like 1.5");
const isoDate = z.iso.date();
const key = z.string().regex(/^[a-z0-9_]{1,40}$/);

/**
 * A spending category cards reward. The category itself is Tidysum's (dining, groceries); `codes`
 * maps it to each data source's transaction categories, so supporting another aggregator means
 * adding its codes here rather than changing the cards.
 */
const Category = z
  .object({
    label: z.string().min(1).max(60),
    codes: z
      .object({
        /** Plaid detailed codes (e.g. FOOD_AND_DRINK_GROCERIES) or whole primaries (e.g. TRAVEL). */
        plaid: z.array(z.string().regex(/^[A-Z_]{3,80}$/)).min(1),
      })
      .strict(),
    /**
     * false when cards don't normally earn their base rate here (rent, taxes): paying by card
     * costs a fee or isn't accepted, so only a card with an explicit rate for it gets credit.
     */
    card_payable: z.boolean().default(true),
    /** Why a category isn't card-payable, shown to the user (default: can't go on a card). */
    card_note: z.string().min(1).max(60).optional(),
  })
  .strict();

const NETWORKS = ["visa", "mastercard", "amex", "discover"] as const;
const Network = z.enum(NETWORKS);

/**
 * A merchant that only takes some card networks (Costco warehouses take only Visa credit). Bank
 * spending there only counts toward a card on one of these networks.
 */
const Acceptance = z
  .object({
    /** Lowercase fragments matched against the merchant name. */
    match: z.array(z.string().min(3).max(40)).min(1),
    networks: z.array(Network).min(1),
    note: z.string().min(1).max(120),
    source_url: z.url().refine((u) => u.startsWith("https://"), "must be https"),
  })
  .strict();

const Cap = z.object({ amount, period: z.enum(["month", "quarter", "year"]) }).strict();

const Rate = z
  .object({
    /** A category key, or merchants (matched case-insensitively against the merchant name). */
    category: key.optional(),
    merchants: z.array(z.string().min(2).max(40)).optional(),
    label: z.string().min(1).max(80),
    rate,
    /** Spend at this rate is capped; above the cap the card's base rate applies. */
    cap: Cap.optional(),
  })
  .strict()
  .refine((r) => !!r.category !== !!r.merchants, "a rate has either a category or merchants");

/**
 * Rates the cardholder picks one of (PayPal Debit's monthly 5% category). Tidysum counts the one
 * that earns the most on the user's spending, as if they picked it every month.
 */
const ChooseOne = z
  .object({
    /** What the pick is called, e.g. "your monthly 5% category". */
    label: z.string().min(1).max(60),
    rates: z.array(Rate).min(2),
  })
  .strict();

const Card = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,60}$/),
    issuer: z.string().min(1).max(60),
    name: z.string().min(1).max(100),
    /**
     * debit: spends from a bank or wallet balance (PayPal Debit). It is matched against the
     * user's depository accounts instead of their credit cards, and purchases from that account
     * count as card spending.
     */
    kind: z.enum(["credit", "debit"]).default("credit"),
    annual_fee: amount,
    /** A paid membership the rates depend on (e.g. Robinhood Gold), per year. */
    membership: z
      .object({ name: z.string().min(1).max(60), annual_cost: amount })
      .strict()
      .optional(),
    /** Percent; null when the issuer's page doesn't state it (treated as 3% abroad). */
    foreign_transaction_fee: z
      .string()
      .regex(/^\d(\.\d{1,2})?$/)
      .nullable(),
    reward: z.discriminatedUnion("currency", [
      z.object({ currency: z.literal("cash") }).strict(),
      z
        .object({
          currency: z.literal("points"),
          program: z.string().min(1).max(60),
          /** What one point is worth redeemed as cash or statement credit, in cents. */
          cents_per_point: z.string().regex(/^\d(\.\d{1,3})?$/),
        })
        .strict(),
    ]),
    /** The card network, when the issuer issues the card on only one. */
    network: Network.optional(),
    base_rate: rate,
    rates: z.array(Rate).default([]),
    choose_one: ChooseOne.optional(),
    /** Conditions for the rates, other than the membership. */
    requires: z.string().max(300).optional(),
    /** Welcome bonus text; never counted in yearly figures. */
    welcome_offer: z.string().max(300).optional(),
    notes: z.string().max(500).optional(),
    /**
     * Lowercase fragments of the account's official name that identify this card when an
     * institution reports it. Leave empty when the reported name is too generic.
     */
    match: z.array(z.string().min(3).max(60)).default([]),
    source_url: z.url().refine((u) => u.startsWith("https://"), "must be https"),
    verified_on: isoDate,
  })
  .strict();

export const CardCatalogSchema = z
  .object({
    version: z.literal(1),
    categories: z.record(key, Category),
    acceptance: z.array(Acceptance).default([]),
    cards: z.array(Card).min(1),
  })
  .strict()
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    for (const card of c.cards) {
      if (ids.has(card.id))
        ctx.addIssue({ code: "custom", message: `duplicate card id ${card.id}` });
      ids.add(card.id);
      for (const r of [...card.rates, ...(card.choose_one?.rates ?? [])]) {
        if (r.category && !c.categories[r.category]) {
          ctx.addIssue({ code: "custom", message: `${card.id}: unknown category ${r.category}` });
        }
      }
    }
  });

export type CardCatalog = z.infer<typeof CardCatalogSchema>;
export type Card = z.infer<typeof Card>;
export type Network = z.infer<typeof Network>;

/** Percent of spend a card's rate is worth in cash. */
export function cashPercent(card: Card, r: string): Big {
  return card.reward.currency === "cash"
    ? new Big(r)
    : new Big(r).times(card.reward.cents_per_point);
}

export function parseCardCatalog(json: unknown): CardCatalog {
  const result = CardCatalogSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid card catalog:\n  ${issues.join("\n  ")}`);
  }
  return result.data;
}

export async function loadCardCatalogFile(path: string): Promise<CardCatalog> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`can't read card catalog ${path}: ${(err as Error).message}`);
  }
  try {
    return parseCardCatalog(JSON.parse(text));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`card catalog ${path} is not valid JSON: ${err.message}`);
    }
    throw err;
  }
}

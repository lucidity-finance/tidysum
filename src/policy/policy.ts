import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import Big from "big.js";
import { z } from "zod";

// A user's rules. They are written as JSON and stored per user in the database (`tidysum policy
// set`). Every distinct content gets its own version id, and each proposal records the version it
// was checked against.

const amount = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, "must be a decimal string like 1000.00");
const fraction = z
  .string()
  .regex(/^(0(\.\d{1,4})?|1(\.0{1,4})?)$/, "must be a decimal between 0 and 1, like 0.25");

const Bucket = z
  .object({
    target: fraction,
    /**
     * Asset classes from catalog/securities.json this bucket holds, so funds the catalog knows
     * are counted without listing them. Default: the classes in the bucket's name
     * ("bonds_and_cash" holds bonds and cash).
     */
    asset_classes: z
      .array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/))
      .min(1)
      .optional(),
    /**
     * Ticker symbols counted in this bucket, matched case-insensitively. They win over the
     * catalog, and the first one held (or else the first one) is what a rebalance suggests buying.
     */
    tickers: z.array(z.string().min(1).max(12)).default([]),
    /**
     * Asset location: false keeps this bucket out of the new-money split, which is what a taxable
     * brokerage buys from each paycheck. Tax-advantaged accounts (a 401(k)'s own paycheck
     * election) and hand-entered holdings fill it instead, like bonds whose interest would be
     * taxed every year in a taxable account. Default true.
     */
    taxable_new_money: z.boolean().default(true),
    /** Also count holdings Plaid marks as cash equivalents (money market sweeps). */
    cash_equivalents: z.boolean().default(false),
    /** Fallback for holdings whose ticker no bucket lists, by Plaid security type. */
    security_types: z
      .array(
        z.enum([
          "equity",
          "etf",
          "mutual fund",
          "fixed income",
          "cash",
          "derivative",
          "cryptocurrency",
          "other",
        ]),
      )
      .default([]),
  })
  .strict();

/** The money styles a policy can start from (src/policy/styles.ts, decision 0009). */
export const STYLE_IDS = [
  "adviser_standard",
  "debt_free_first",
  "index_and_chill",
  "early_retirement",
  "all_weather",
  "safety_first",
] as const;
export type StyleId = (typeof STYLE_IDS)[number];

const RETIRED_STYLE_IDS = new Set(["classic_60_40"]);
const isRetiredStyle = (v: unknown) =>
  typeof v === "object" && v !== null && RETIRED_STYLE_IDS.has(String((v as { id?: unknown }).id));

export const PolicySchema = z
  .object({
    version: z.literal(1),
    /**
     * The money style this policy was filled from, so the page can say which one it is and what
     * was changed since. Only a label: the rules below are what the checks read.
     */
    style: z.preprocess(
      // "Classic 60/40" was replaced by "Adviser standard" (2026-11-20). A policy filled from it
      // keeps its rules and reads as the owner's own, since they no longer match any style.
      (v) => (isRetiredStyle(v) ? undefined : v),
      z
        .object({
          id: z.enum(STYLE_IDS),
          /** The age a style's mix was worked out for (both age-based styles' mixes follow it). */
          age: z.number().int().min(18).max(90).optional(),
          /**
           * The country whose funds the style's buckets were filled with, when not the US
           * (src/region.ts): a Canadian buys Canadian-listed funds.
           */
          country: z
            .string()
            .regex(/^[A-Z]{2}$/)
            .optional(),
        })
        .strict()
        .optional(),
    ),
    cash: z
      .object({
        /** Keep this much across the cash accounts: a fixed amount or months of average spending. */
        buffer: z.union([
          z.object({ amount }).strict(),
          z.object({ months_of_spending: z.number().int().min(1).max(24) }).strict(),
        ]),
        /** Ignore excess or shortfall smaller than this. */
        tolerance: amount.default("500"),
        /**
         * A smaller buffer kept while there is consumer debt to pay off (a loan other than a
         * mortgage, or a card that charged interest in the last year), so spare cash goes to the
         * debt first: "Debt-free first" keeps $1,000 until the debt is gone. Absent: the buffer
         * above always applies.
         */
        buffer_while_in_debt: z.object({ amount }).strict().optional(),
        /** Cash account ids. Default: every checking, savings, money market and cash management account. */
        account_ids: z.array(z.uuid()).optional(),
      })
      .strict(),
    cards: z
      .object({
        pay_statement_in_full: z.boolean().default(true),
        /**
         * Steer away from credit cards: Tidysum stops suggesting new cards or moving bills onto
         * cards. Statements are still checked, so balances get paid off. Absent: false.
         */
        avoid_credit_cards: z.boolean().optional(),
      })
      .strict()
      .default({
        pay_statement_in_full: true,
      }),
    debt: z
      .object({
        /**
         * Where excess cash beyond the buffer should go first: the debt with the highest APR
         * (avalanche), or the smallest balance, mortgages aside (snowball).
         */
        extra_payments: z.enum(["none", "highest_apr", "smallest_balance"]).default("none"),
      })
      .strict()
      .default({ extra_payments: "none" }),
    allocation: z
      .object({
        /** Flag a bucket when its weight is off target by more than this (0.05 = 5 points). */
        drift_band: fraction.default("0.05"),
        /**
         * The most of each new contribution one bucket may take while the mix catches up, like
         * "0.6": the rest follows the targets. None sends it all to whatever is under target.
         */
        new_money_max_share: fraction
          .refine((s) => new Big(s).gte("0.2"), "new_money_max_share must be at least 0.2")
          .optional(),
        buckets: z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), Bucket),
        /** Investment account ids. Default: every investment account. */
        account_ids: z.array(z.uuid()).optional(),
      })
      .strict()
      .refine(
        (a) =>
          Object.values(a.buckets)
            .reduce((sum, b) => sum.plus(b.target), new Big(0))
            .eq(1),
        "bucket targets must add up to 1",
      )
      .optional(),
    /**
     * A small, capped slice for investment-miner's research picks, kept apart from the core
     * allocation: positions in `tickers` count toward the cap, not toward any bucket. Buys into
     * it only come from new money, never from selling, and only while it is under the cap. A
     * miner score is research evidence, not a target weight or an instruction to trade.
     */
    research_sleeve: z
      .object({
        /** Most of investable assets the sleeve may hold, like "0.05". At most a quarter. */
        cap: fraction.refine((s) => new Big(s).lte("0.25"), "a research sleeve is capped at 0.25"),
        /** Tickers held as research-sleeve positions, matched case-insensitively. */
        tickers: z.array(z.string().regex(/^[A-Za-z0-9.^=-]{1,15}$/)).default([]),
      })
      .strict()
      .optional(),
    robinhood: z
      .object({
        /** How much the owner keeps in the Robinhood agentic account, the only place trades run. */
        agentic_account_funding: amount,
      })
      .strict()
      .optional(),
    /**
     * Hard limits. A proposal over a cap is stored as blocked; an absent cap means none. Trades
     * are also bounded by the agentic account's balance, since nothing else can trade.
     */
    limits: z
      .object({
        max_action_amount: amount.optional(),
        max_proposal_total: amount.optional(),
        /** Order types Phase 4 may place. Only limit orders are supported. */
        order_types: z.array(z.literal("limit")).min(1).default(["limit"]),
      })
      .strict()
      .default({ order_types: ["limit"] }),
  })
  .strict()
  .refine(
    (p) => {
      const sleeve = new Set((p.research_sleeve?.tickers ?? []).map((t) => t.toUpperCase()));
      return !Object.values(p.allocation?.buckets ?? {}).some((b) =>
        b.tickers.some((t) => sleeve.has(t.toUpperCase())),
      );
    },
    {
      message: "a research sleeve ticker can't also be listed in a bucket",
      path: ["research_sleeve", "tickers"],
    },
  );

export type Policy = z.infer<typeof PolicySchema>;

export interface LoadedPolicy {
  /** sha256 of the canonical JSON, so the same rules always map to the same version. */
  versionId: string;
  policy: Policy;
}

/** JSON with object keys sorted, so formatting and key order don't create new versions. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parsePolicy(json: unknown): LoadedPolicy {
  const result = PolicySchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid policy:\n  ${issues.join("\n  ")}`);
  }
  const versionId = createHash("sha256").update(canonical(result.data)).digest("hex");
  return { versionId, policy: result.data };
}

export async function loadPolicyFile(path: string): Promise<LoadedPolicy> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`can't read policy file ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`policy file ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parsePolicy(json);
}

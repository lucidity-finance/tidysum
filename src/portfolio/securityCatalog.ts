import { readFile } from "node:fs/promises";
import Big from "big.js";
import { z } from "zod";

// What each fund or stock is made of, by asset class, so holdings can be counted against a
// policy's target allocation without the user listing every ticker. A checked-in JSON file like
// the deposit and card catalogs. A fund that spans classes (a global ETF) has its split, the page
// it came from and the date on that page, since those splits drift.
//
// A split names asset classes ("us_stocks") or, where it matters, a sleeve inside one
// ("us_stocks.large", "us_stocks.small_mid"). The policy's buckets count classes, so a sleeve
// counts toward its class. Sleeves are what a cheaper copy of a fund is matched on (decision
// 0007): an S&P 500 fund is copied by another fund holding only US large caps, never by "some US
// stock fund". A bare class means "this class, not broken down", which only a fund recorded the
// same way can copy.

const isoDate = z.iso.date();
const className = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
/** An asset class, or a sleeve inside one: `class.sleeve`. */
export const sleeveName = z.string().regex(/^[a-z][a-z0-9_]{0,39}(\.[a-z][a-z0-9_]{0,39})?$/);
const share = z
  .string()
  .regex(/^(0(\.\d{1,4})?|1(\.0{1,4})?)$/, "must be a decimal between 0 and 1");

const Security = z
  .object({
    ticker: z.string().regex(/^[A-Z0-9.-]{1,12}$/),
    name: z.string().min(1).max(120),
    /**
     * Where it is listed, when not the US: an ISO country code (src/region.ts), or "EU" for the
     * UCITS ETFs sold across the EU (src/region.ts fundMarket). Only US funds take their fee from
     * the SEC's data.
     */
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    /** Share of the fund in each asset class or sleeve; adds up to 1. */
    mix: z.record(sleeveName, share),
    /** Yearly cost in percent, like "0.02", for funds whose fee Tidysum compares. */
    expense_ratio: z
      .string()
      .regex(/^\d{1,2}(\.\d{1,4})?$/, "must be a percent like 0.02")
      .optional(),
    notes: z.string().max(300).optional(),
    source_url: z
      .url()
      .refine((u) => u.startsWith("https://"), "must be https")
      .optional(),
    /** The date the source states its breakdown for. */
    mix_as_of: isoDate.optional(),
    verified_on: isoDate.optional(),
  })
  .strict()
  .refine(
    (s) =>
      Object.values(s.mix)
        .reduce((sum, v) => sum.plus(v), new Big(0))
        .eq(1),
    "mix must add up to 1",
  )
  .refine(
    (s) => Object.keys(s.mix).length === 1 || (s.source_url && s.mix_as_of && s.verified_on),
    "a fund split across classes or sleeves needs source_url, mix_as_of and verified_on",
  );

/**
 * Target-date funds in workplace plans often have no ticker ("The 2055 Retirement Fund"), so
 * they're matched by name and split by a typical glide path: the stock share by years left to
 * the target year, interpolated between points, and the rest in one class. Good enough to count
 * a portfolio by class, never to copy the fund: a swap needs the fund's own published mix
 * (decision 0007).
 */
const TargetDate = z
  .object({
    /** Stock share at a number of years before the target year (negative is after it). */
    stocks: z.array(z.object({ years: z.number().int().min(-30).max(60), share }).strict()).min(2),
    /** How the stock share splits across classes; adds up to 1. */
    stock_mix: z.record(className, share),
    /** The class the rest is in. */
    rest: className,
    notes: z.string().max(300).optional(),
    source_url: z.url().refine((u) => u.startsWith("https://"), "must be https"),
    mix_as_of: isoDate,
    verified_on: isoDate,
  })
  .strict()
  .refine(
    (t) =>
      Object.values(t.stock_mix)
        .reduce((sum, v) => sum.plus(v), new Big(0))
        .eq(1),
    "stock_mix must add up to 1",
  );

export const SecurityCatalogSchema = z
  .object({
    version: z.literal(1),
    /** Asset class keys and how to show them. */
    classes: z.record(className, z.string().min(1).max(60)),
    /** Sleeves inside a class (`us_stocks.large`) and how to show them. */
    sleeves: z.record(sleeveName, z.string().min(1).max(60)).default({}),
    /** A broad, low-cost fund to buy for each class when a policy bucket names none. */
    default_buy: z.record(className, z.string().regex(/^[A-Z0-9.-]{1,12}$/)),
    /** The same, for owners elsewhere, by src/region.ts fundMarket: funds sold where they live. */
    default_buy_by_country: z
      .record(
        z.string().regex(/^[A-Z]{2}$/),
        z.record(className, z.string().regex(/^[A-Z0-9.-]{1,12}$/)),
      )
      .default({}),
    securities: z.array(Security),
    target_date: TargetDate.optional(),
  })
  .strict()
  .refine(
    (c) => new Set(c.securities.map((s) => s.ticker)).size === c.securities.length,
    "tickers must be unique",
  )
  .refine(
    (c) =>
      Object.keys(c.sleeves).every((k) => k.includes(".") && classOf(k) in c.classes) &&
      c.securities.every((s) =>
        Object.keys(s.mix).every((k) => (k.includes(".") ? k in c.sleeves : k in c.classes)),
      ) &&
      (!c.target_date ||
        [...Object.keys(c.target_date.stock_mix), c.target_date.rest].every((k) => k in c.classes)),
    "every mix class must be listed in classes, and every sleeve in sleeves",
  );

export type SecurityCatalog = z.infer<typeof SecurityCatalogSchema>;

/** The asset class a class or sleeve counts toward: `us_stocks` for `us_stocks.large`. */
export const classOf = (sleeve: string) => sleeve.split(".")[0] ?? sleeve;

/** A split by sleeve added up by asset class. */
export function classMix(mix: Record<string, Big.BigSource>): Record<string, Big> {
  const out: Record<string, Big> = {};
  for (const [k, v] of Object.entries(mix)) {
    const cls = classOf(k);
    out[cls] = (out[cls] ?? new Big(0)).plus(v);
  }
  return out;
}

/** How to show a class or sleeve: "US large-cap stocks". */
export function sleeveLabel(catalog: SecurityCatalog | undefined, sleeve: string): string {
  return (
    catalog?.sleeves[sleeve] ??
    catalog?.classes[sleeve] ??
    catalog?.classes[classOf(sleeve)] ??
    sleeve.replace(/[._]/g, " ")
  );
}

/** A target year in a fund name that also says what kind of fund it is. */
const TARGET_YEAR = /\b(20[1-9]\d)\b/;
const TARGET_WORDS = /retirement|target|lifepath|freedom|lifecycle|life cycle|destination/i;

/**
 * The asset-class split of a target-date fund, from its name and the catalog's glide path, or
 * null when the name has no target year. `year` is the current year.
 */
export function targetDateMix(
  catalog: SecurityCatalog | undefined,
  name: string | null,
  year: number,
): Record<string, Big> | null {
  const glide = catalog?.target_date;
  const match = name && TARGET_WORDS.test(name) ? TARGET_YEAR.exec(name) : null;
  if (!glide || !match?.[1]) return null;
  const left = Number(match[1]) - year;
  const points = [...glide.stocks].sort((a, b) => b.years - a.years);
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  let stocks = new Big(left >= first.years ? first.share : last.share);
  for (let i = 0; i + 1 < points.length; i++) {
    const hi = points[i];
    const lo = points[i + 1];
    if (!hi || !lo || left > hi.years || left < lo.years) continue;
    const t = new Big(left - lo.years).div(hi.years - lo.years);
    stocks = new Big(lo.share).plus(new Big(hi.share).minus(lo.share).times(t));
    break;
  }
  const mix: Record<string, Big> = {};
  for (const [cls, part] of Object.entries(glide.stock_mix)) {
    mix[cls] = (mix[cls] ?? new Big(0)).plus(stocks.times(part));
  }
  mix[glide.rest] = (mix[glide.rest] ?? new Big(0)).plus(new Big(1).minus(stocks));
  return mix;
}
export type CatalogSecurity = z.infer<typeof Security>;

export function parseSecurityCatalog(json: unknown): SecurityCatalog {
  const result = SecurityCatalogSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid security catalog:\n  ${issues.join("\n  ")}`);
  }
  return result.data;
}

export async function loadSecurityCatalogFile(path: string): Promise<SecurityCatalog> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`can't read security catalog ${path}: ${(err as Error).message}`);
  }
  try {
    return parseSecurityCatalog(JSON.parse(text));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`security catalog ${path} is not valid JSON: ${err.message}`);
    }
    throw err;
  }
}

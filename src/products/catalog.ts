import { readFile } from "node:fs/promises";
import Big from "big.js";
import { z } from "zod";

// Deposit products Tidysum compares a user's cash accounts against. The rates live in a checked-in
// JSON file, each one with the page it came from and the date someone last checked that page,
// so every number in a suggestion can be traced and re-verified. Nothing here is fetched live.

const amount = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, "must be a decimal string like 1000.00");
/** APY in percent, like "3.30" for 3.30%. */
const percent = z.string().regex(/^\d{1,2}(\.\d{1,4})?$/, "must be a percent like 3.30");
const isoDate = z.iso.date();

/**
 * Balance tiers, lowest first. The rate of the highest tier the balance reaches applies to the
 * whole balance, which is how the banks in the catalog pay tiered rates.
 */
const Tiers = z
  .array(z.object({ from: amount, apy: percent }).strict())
  .min(1)
  .refine((t) => new Big(t[0]?.from ?? 1).eq(0), "the first tier must start at 0")
  .refine(
    (t) => t.every((tier, i) => i === 0 || new Big(tier.from).gt(t[i - 1]?.from ?? 0)),
    "tiers must be in increasing order of balance",
  );

export const productKind = ["checking", "savings", "cash_management"] as const;

const Product = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,60}$/),
    provider: z.string().min(1).max(100),
    /**
     * Lowercase fragments of the institution name a data source reports for this provider
     * ("wealthfront"), so Tidysum can tell when a user holds an account there.
     */
    institutions: z.array(z.string().regex(/^[a-z0-9 .&'-]{3,60}$/)).min(1),
    name: z.string().min(1).max(100),
    kind: z.enum(productKind),
    insurance: z.string().min(1).max(100),
    /** What anyone gets, with no conditions. */
    apy: Tiers,
    /** A higher rate for meeting a condition such as direct deposit. */
    conditional_apy: z
      .object({ apy: Tiers, requires: z.string().min(1).max(300) })
      .strict()
      .optional(),
    monthly_fee: amount,
    /** Whether the product charges overdraft or insufficient-funds fees. */
    overdraft_fees: z.boolean(),
    notes: z.string().max(500).optional(),
    /** The provider's own page that states these rates. */
    source_url: z.url().refine((u) => u.startsWith("https://"), "must be https"),
    /** The "rates as of" date printed by the provider. */
    rates_as_of: isoDate,
    /** When someone last checked source_url and found these numbers. */
    verified_on: isoDate,
  })
  .strict();

export const CatalogSchema = z
  .object({ version: z.literal(1), products: z.array(Product).min(1) })
  .strict()
  .refine(
    (c) => new Set(c.products.map((p) => p.id)).size === c.products.length,
    "product ids must be unique",
  );

export type Catalog = z.infer<typeof CatalogSchema>;
export type Product = z.infer<typeof Product>;
export type ApyTiers = z.infer<typeof Tiers>;

/** The APY, in percent, that a balance earns under these tiers. */
/** Whether an institution name, as reported by the data source, is one of these providers'. */
export function atInstitution(institution: string | null, institutions: string[]): boolean {
  const name = institution?.toLowerCase() ?? "";
  return name !== "" && institutions.some((i) => name.includes(i));
}

export function apyFor(tiers: ApyTiers, balance: Big): Big {
  let rate = new Big(tiers[0]?.apy ?? 0);
  for (const t of tiers) if (balance.gte(t.from)) rate = new Big(t.apy);
  return rate;
}

export function parseCatalog(json: unknown): Catalog {
  const result = CatalogSchema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid product catalog:\n  ${issues.join("\n  ")}`);
  }
  return result.data;
}

export async function loadCatalogFile(path: string): Promise<Catalog> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`can't read product catalog ${path}: ${(err as Error).message}`);
  }
  try {
    return parseCatalog(JSON.parse(text));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`product catalog ${path} is not valid JSON: ${err.message}`);
    }
    throw err;
  }
}

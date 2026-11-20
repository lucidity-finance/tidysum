import { z } from "zod";

const base64Key = z
  .string()
  .refine((s) => Buffer.from(s, "base64").length === 32, "must be 32 bytes, base64-encoded");

/** `NAME=` in .env means unset, not an empty value. */
const unsetIfEmpty = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const DbEnv = z.object({ DATABASE_URL: z.string().min(1) });

const PlaidEnv = z.object({
  PLAID_CLIENT_ID: z.string().min(1),
  PLAID_SECRET: z.string().min(1),
  PLAID_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  TIDYSUM_TOKEN_KEY: base64Key,
});

export type PlaidConfig = z.infer<typeof PlaidEnv>;

/** True for a bind address only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

const ServerEnv = z
  .object({
    /**
     * HTTP Basic password for the admin page. Only needed when HOST is reachable from other
     * machines; on loopback the page is open to this machine. Generate: openssl rand -base64 32
     */
    TIDYSUM_ADMIN_TOKEN: unsetIfEmpty(z.string().min(32, "must be at least 32 characters")),
    /** Public https origin Plaid sends webhooks to; unset means no webhooks (local use). */
    TIDYSUM_PUBLIC_URL: unsetIfEmpty(
      z.url().refine((u) => u.startsWith("https://"), "must be https"),
    ),
    /** Bearer token for the agent MCP endpoint at /mcp; unset turns the endpoint off. */
    TIDYSUM_MCP_TOKEN: unsetIfEmpty(z.string().min(32, "must be at least 32 characters")),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(15).default(360),
    /** How soon a connection that failed on Plaid's or the bank's side is tried again. */
    SYNC_RETRY_MINUTES: z.coerce.number().int().min(15).default(30),
  })
  .refine((c) => c.TIDYSUM_ADMIN_TOKEN !== undefined || isLoopbackHost(c.HOST), {
    message: "required when HOST is not a loopback address",
    path: ["TIDYSUM_ADMIN_TOKEN"],
  });

function parse<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const fields = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n  ${fields.join("\n  ")}`);
  }
  return result.data;
}

export const loadDbConfig = (env = process.env) => parse(DbEnv, env);
export const loadPlaidConfig = (env = process.env) => parse(PlaidEnv, env);
export const loadServerConfig = (env = process.env) => parse(ServerEnv, env);

/** Deposit product rates with their sources. Relative paths resolve from the working directory. */
export const productsPath = (env = process.env) =>
  env.TIDYSUM_PRODUCTS_FILE || "catalog/deposit-products.json";

/** Credit card terms with their sources. Relative paths resolve from the working directory. */
export const cardsPath = (env = process.env) =>
  env.TIDYSUM_CARDS_FILE || "catalog/credit-cards.json";

/** What funds hold by asset class. Relative paths resolve from the working directory. */
export const securitiesPath = (env = process.env) =>
  env.TIDYSUM_SECURITIES_FILE || "catalog/securities.json";

/** The owner's plan file, loaded by `tidysum plan set`; unset means none is configured. */
export const planPath = (env = process.env) => env.TIDYSUM_PLAN_FILE || undefined;

/**
 * investment-miner's directory, read through its own CLI for the research sleeve; unset means
 * no research is imported.
 */
export const minerDir = (env = process.env) => env.TIDYSUM_MINER_DIR || undefined;

/** Hours between reads of investment-miner while `tidysum serve` runs. */
export const minerIntervalHours = (env = process.env) => {
  const n = Number(env.TIDYSUM_MINER_INTERVAL_HOURS || 1);
  return Number.isFinite(n) && n >= 0.25 ? n : 1;
};

/**
 * investment-miner's API, which runs its scans and weekday schedule (deploy/macos-setup.sh
 * starts it on loopback). Tidysum asks it to start a scan; it signs in with the AUTH_PASSWORD
 * from the miner's own .env.
 */
export const minerUrl = (env = process.env) =>
  (env.TIDYSUM_MINER_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");

/**
 * How Tidysum tells the owner an action is due (decision 0006): "macos" (a notification, the
 * default on a Mac), "log" (the server log only, the default elsewhere) or "off".
 */
export const notifyMode = (env = process.env, platform = process.platform) => {
  const v = env.TIDYSUM_NOTIFY;
  if (v === "macos" || v === "log" || v === "off") return v;
  return platform === "darwin" ? "macos" : "log";
};

/**
 * The owner's own agent, as a shell command, which Tidysum starts on an approved action when it
 * comes due (decision 0006), with TIDYSUM_ACTION_ID and TIDYSUM_ACTION_PROMPT set. Unset: Tidysum
 * only tells the owner, and their agent picks it up when they ask it to.
 */
export const agentCommand = (env = process.env) => env.TIDYSUM_AGENT_COMMAND?.trim() || undefined;

/** Local hours, "from-to", in which Tidysum may start the owner's agent. Default 8-21. */
export const agentHours = (env = process.env): [number, number] => {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(env.TIDYSUM_AGENT_HOURS?.trim() ?? "");
  const from = m ? Number(m[1]) : 8;
  const to = m ? Number(m[2]) : 21;
  return from >= 0 && to <= 24 && from < to ? [from, to] : [8, 21];
};

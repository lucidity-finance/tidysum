import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import pg from "pg";
import { draftActions } from "../actions/actions.js";
import { TokenCipher } from "../crypto/tokenCipher.js";
import { type Db, runMigrations } from "../db/client.js";
import { account, appUser, marketReading } from "../db/schema.js";
import { TREASURY_SERIES } from "../facts/refresh.js";
import type { AgentDb } from "../mcp/agentDb.js";
import type { ProductTools } from "../mcp/server.js";
import { loadCatalogs } from "../misallocation/detect.js";
import { refreshMisallocations } from "../misallocation/ledger.js";
import { setPlan } from "../plan/plan.js";
import { parsePolicy } from "../policy/policy.js";
import { activatePolicy } from "../policy/store.js";
import { readAllocation } from "../portfolio/allocation.js";
import { setIraYear } from "../retirement/ira.js";
import { readWorkplacePlans, setWorkplacePlan } from "../retirement/workplace.js";
import { linkItem } from "../sync/items.js";
import { syncItem } from "../sync/syncItem.js";
import { resolveUserId } from "../users.js";
import { DemoPlaid } from "./gateway.js";
import type { DemoHousehold } from "./household.js";
import { TBILL_13W } from "./realWorld.js";

/**
 * The demo's own database, in a Postgres server of its own: by default one Tidysum runs itself
 * (`tidysum demo`), or TIDYSUM_DEMO_DATABASE_URL (`docker compose up -d demo-db` makes one).
 */
export const DEMO_DATABASE = "tidysum_demo";

const SYSTEM_DATABASES = new Set(["postgres", "template0", "template1", DEMO_DATABASE]);

/** A container that just started can take a few seconds to take connections. */
async function connectWithRetry(connectionString: string, attempts = 20): Promise<pg.Client> {
  for (let i = 1; ; i++) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      return client;
    } catch (err) {
      await client.end().catch(() => {});
      if (i >= attempts) {
        throw new Error(
          `can't reach the demo database (${(err as Error).message}). Is the server at TIDYSUM_DEMO_DATABASE_URL running?`,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/**
 * Starts the demo database from scratch. The demo's roles are server-wide, so this drops them
 * too, and refuses unless the server holds nothing but the demo: it never touches a server that
 * has a real Tidysum database on it.
 */
export async function resetDemoDatabase(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl);
  if (url.pathname.replace(/^\//, "") !== DEMO_DATABASE) {
    throw new Error(`the demo only runs in a database named ${DEMO_DATABASE}`);
  }
  url.pathname = "/postgres";
  const client = await connectWithRetry(url.toString());
  try {
    const { rows } = await client.query<{ datname: string }>("select datname from pg_database");
    const others = rows.map((r) => r.datname).filter((n) => !SYSTEM_DATABASES.has(n));
    // Tidysum's tables can live in the default database too.
    const { rows: tidysum } = await client.query<{ found: string | null }>(
      "select to_regclass('public.app_user')::text as found",
    );
    if (tidysum[0]?.found) others.push("Tidysum tables in the postgres database");
    if (others.length > 0) {
      throw new Error(
        `refusing to reset: this Postgres server also holds ${others.join(", ")}. ` +
          "The demo needs a server of its own: leave TIDYSUM_DEMO_DATABASE_URL unset and Tidysum runs one.",
      );
    }
    await client.query(`drop database if exists ${DEMO_DATABASE} with (force)`);
    for (const role of ["tidysum_proposer", "tidysum_agent", "purser_proposer", "purser_agent"]) {
      await client.query(`drop role if exists ${role}`);
    }
    await client.query(`create database ${DEMO_DATABASE}`);
  } finally {
    await client.end();
  }
}

/**
 * Fills a fresh demo database with the made-up household through the same path real data takes:
 * link, sync, record the 401(k) and IRA, set rules and a plan, then find and price what's in the
 * wrong place and draft the actions.
 */
export async function seedDemo(
  db: Db,
  household: DemoHousehold,
  products: ProductTools,
  connectAgentDb: (userId: string) => AgentDb,
  opts: { userId?: string; planFile?: string } = {},
): Promise<{ userId: string; plaid: DemoPlaid; cipher: TokenCipher; agentDb: AgentDb }> {
  await runMigrations(db);
  // A fresh demo database has one user, made by the migration.
  const userId = opts.userId ?? (await resolveUserId(db, {}));
  await db
    .update(appUser)
    .set({ displayName: "Demo household", investingEnabled: true })
    .where(eq(appUser.id, userId));

  const plaid = new DemoPlaid(household);
  // A throwaway key: the demo's "access tokens" are made up and the database is reset each run.
  const cipher = new TokenCipher(randomBytes(32).toString("base64"));
  const now = () => new Date();
  for (const inst of household.institutions) {
    const itemId = await linkItem(db, plaid, cipher, userId, inst.token);
    const r = await syncItem(db, plaid, cipher, itemId, now);
    if (r.status !== "succeeded") throw new Error(`demo sync of ${inst.name} failed: ${r.error}`);
  }

  const [k401] = await db
    .select({ id: account.id })
    .from(account)
    .where(eq(account.plaidAccountId, household.workplace.plaidAccountId));
  if (!k401) throw new Error("demo 401(k) account missing after sync");
  await setWorkplacePlan(db, userId, k401.id, household.workplace.facts);
  await setIraYear(db, userId, household.ira);
  await activatePolicy(db, userId, parsePolicy(household.policy));
  await setPlan(
    db,
    userId,
    await readFile(opts.planFile ?? new URL("../../docs/plan.example.md", import.meta.url), "utf8"),
  );

  // The cash yardstick, as Treasury published it, so idle cash is priced without a network fetch.
  await db
    .insert(marketReading)
    .values({ series: TREASURY_SERIES, day: TBILL_13W.day, value: TBILL_13W.yield })
    .onConflictDoNothing();

  const agentDb = connectAgentDb(userId);
  await refreshMisallocations(db, agentDb, userId, await loadCatalogs(products), household.today);
  const securities = products.loadSecurityCatalog
    ? await products.loadSecurityCatalog()
    : undefined;
  await draftActions(
    db,
    userId,
    now(),
    securities ? await readAllocation(agentDb, securities, household.today) : undefined,
    await readWorkplacePlans(agentDb),
  );
  return { userId, plaid, cipher, agentDb };
}

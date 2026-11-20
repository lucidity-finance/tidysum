import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { policyVersion } from "../db/schema.js";
import type { AgentDb } from "../mcp/agentDb.js";
import { readRegion } from "../users.js";
import { type LoadedPolicy, type Policy, parsePolicy, type StyleId } from "./policy.js";
import { applyStyle, type Change, changesBetween } from "./styles.js";

/**
 * Makes `loaded` the user's active policy. Versions are kept (proposals point at the one they
 * were checked against); setting an existing version again just reactivates it.
 */
export async function activatePolicy(db: Db, userId: string, loaded: LoadedPolicy) {
  await db
    .insert(policyVersion)
    .values({ userId, id: loaded.versionId, content: loaded.policy })
    .onConflictDoUpdate({
      target: [policyVersion.userId, policyVersion.id],
      set: { activatedAt: sql`now()` },
    });
}

/** The session user's active policy, read through row-level security. */
export async function loadActivePolicy(db: AgentDb): Promise<LoadedPolicy> {
  const { rows } = await db.query<{ id: string; content: unknown }>(
    "select id, content from policy_version order by activated_at desc limit 1",
  );
  const [row] = rows;
  if (!row) throw new Error("no policy set for this user; run `tidysum policy set <file>`");
  const loaded = parsePolicy(row.content);
  if (loaded.versionId !== row.id) {
    // Defaults added since the version was stored change the canonical form; keep the stored id
    // so proposals still point at the row that exists.
    return { versionId: row.id, policy: loaded.policy };
  }
  return loaded;
}

/** The user's active policy, read as the owner, or null when none is set. */
export async function readOwnerPolicy(db: Db, userId: string): Promise<LoadedPolicy | null> {
  const [row] = await db
    .select({ id: policyVersion.id, content: policyVersion.content })
    .from(policyVersion)
    .where(eq(policyVersion.userId, userId))
    .orderBy(desc(policyVersion.activatedAt))
    .limit(1);
  if (!row) return null;
  return { versionId: row.id, policy: parsePolicy(row.content).policy };
}

/**
 * Fills the user's policy from a money style and makes it active, or with `dryRun` only says what
 * would change. Only the owner does this (the command line or the admin page): an agent's MCP
 * tools can read styles but never rewrite the rules they are checked against.
 */
export async function setStyle(
  db: Db,
  userId: string,
  id: StyleId,
  opts: { age?: number; dryRun?: boolean } = {},
): Promise<{ versionId: string; policy: Policy; changes: Change[]; applied: boolean }> {
  const current = await readOwnerPolicy(db, userId);
  const { country } = await readRegion(db, userId);
  const next = parsePolicy(
    applyStyle(current?.policy ?? null, id, {
      ...(opts.age !== undefined ? { age: opts.age } : {}),
      country,
    }),
  );
  const changes = changesBetween(current?.policy ?? null, next.policy);
  if (!opts.dryRun) await activatePolicy(db, userId, next);
  return { versionId: next.versionId, policy: next.policy, changes, applied: !opts.dryRun };
}

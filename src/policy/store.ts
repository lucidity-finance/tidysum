import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { policyVersion } from "../db/schema.js";
import type { AgentDb } from "../mcp/agentDb.js";
import { type LoadedPolicy, parsePolicy } from "./policy.js";

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

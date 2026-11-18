import pg from "pg";

// Hand dates and timestamps to agents as Postgres prints them, not as JS Dates.
// numeric already arrives as a string, which is what money needs.
const RAW_TEXT = new Set([
  1082, // date
  1114, // timestamp
  1184, // timestamptz
]);
const types = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    RAW_TEXT.has(oid)
      ? (v: string) => v
      : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

export type AgentDb = pg.Pool;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Role, user, read-only mode, UTC and a statement timeout are startup parameters, so they hold
 * before the first query and no agent-facing code path issues SET. Row-level security limits
 * every query to `userId`'s rows. If the login user can't assume the role, connecting fails.
 */
function connectAs(databaseUrl: string, role: string, userId: string, readOnly: boolean): AgentDb {
  if (!UUID.test(userId)) throw new Error(`not a user id: ${userId}`);
  const options = [
    `-c role=${role}`,
    `-c tidysum.user_id=${userId}`,
    `-c default_transaction_read_only=${readOnly ? "on" : "off"}`,
    "-c timezone=UTC",
    "-c statement_timeout=10000",
  ].join(" ");
  const url = new URL(databaseUrl);
  // Set through the URL because pg lets connection-string options override config options.
  url.searchParams.set("options", options);
  return new pg.Pool({ connectionString: url.toString(), max: 3, types });
}

/** Read-only, as tidysum_agent, for one user: no Plaid secrets or cursors, no writes. */
export const connectAgent = (databaseUrl: string, userId: string) =>
  connectAs(databaseUrl, "tidysum_agent", userId, true);

/** tidysum_agent's reads plus INSERT on proposals and audit events, for one user. Nothing else. */
export const connectProposer = (databaseUrl: string, userId: string) =>
  connectAs(databaseUrl, "tidysum_proposer", userId, false);

-- Read-only role for agents (Purser MCP server, ad-hoc queries).
-- Grants are explicit per table, so a new table is invisible to agents until it is
-- added here on purpose. item_secret is never granted.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'purser_agent') THEN
    CREATE ROLE purser_agent NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO purser_agent;
--> statement-breakpoint
GRANT SELECT (id, source, institution_id, institution_name, status, status_detail, last_synced_at, created_at)
  ON item TO purser_agent;
--> statement-breakpoint
GRANT SELECT ON account, balance_snapshot, transaction, security, holding, liability, sync_run
  TO purser_agent;

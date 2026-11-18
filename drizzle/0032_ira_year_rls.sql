-- Agents read what went into their own user's IRAs per tax year. Only the owner side (the CLI
-- and the action loop, when an agent finishes an IRA action) writes it.
ALTER TABLE ira_year ADD CONSTRAINT ira_year_facts_check
  CHECK (jsonb_typeof(facts) = 'object' AND length(facts::text) <= 4000);
--> statement-breakpoint
ALTER TABLE ira_year ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ira_year USING (user_id = tidysum_session_user())
  WITH CHECK (user_id = tidysum_session_user());
--> statement-breakpoint
GRANT SELECT ON ira_year TO tidysum_agent;

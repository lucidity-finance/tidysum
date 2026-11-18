-- Agents read what the owner's agent recorded about a workplace retirement plan, for their own
-- user only. Only the owner side (the CLI) writes it.
ALTER TABLE workplace_plan ADD CONSTRAINT workplace_plan_facts_check
  CHECK (jsonb_typeof(facts) = 'object' AND length(facts::text) <= 20000);
--> statement-breakpoint
ALTER TABLE workplace_plan ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON workplace_plan USING (user_id = tidysum_session_user())
  WITH CHECK (user_id = tidysum_session_user());
--> statement-breakpoint
GRANT SELECT ON workplace_plan TO tidysum_agent;

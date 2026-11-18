-- Agents read the owner's pick of where a cash account's spare money goes, for their own user
-- only. Only the owner side (admin page) sets it.
ALTER TABLE deposit_choice ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON deposit_choice USING (user_id = tidysum_session_user())
  WITH CHECK (user_id = tidysum_session_user());
--> statement-breakpoint
GRANT SELECT ON deposit_choice TO tidysum_agent;

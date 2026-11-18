-- The owner's plan. The owner side (CLI) writes it; agents read their own user's row only.
ALTER TABLE financial_plan ADD CONSTRAINT financial_plan_length_check
  CHECK (length(markdown) BETWEEN 1 AND 100000);
--> statement-breakpoint
ALTER TABLE financial_plan ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON financial_plan USING (user_id = tidysum_session_user())
  WITH CHECK (user_id = tidysum_session_user());
--> statement-breakpoint
GRANT SELECT ON financial_plan TO tidysum_agent;

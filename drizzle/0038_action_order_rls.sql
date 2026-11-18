-- Agents read the owner's order for their actions, for their own user only, so they work through
-- approved actions in that order. Only the owner side (admin page) sets it.
ALTER TABLE action_order ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON action_order USING (user_id = tidysum_session_user())
  WITH CHECK (user_id = tidysum_session_user());
--> statement-breakpoint
ALTER TABLE action_order ADD CONSTRAINT action_order_position_check CHECK (position >= 0);
--> statement-breakpoint
GRANT SELECT ON action_order TO tidysum_agent;

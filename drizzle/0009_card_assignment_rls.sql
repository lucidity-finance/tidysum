-- Agents read which catalog card each credit card account is, for their own user only. Only the
-- owner side (admin page, CLI) sets it.
ALTER TABLE card_assignment ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON card_assignment USING (user_id = purser_session_user())
  WITH CHECK (user_id = purser_session_user());
--> statement-breakpoint
GRANT SELECT ON card_assignment TO purser_agent;

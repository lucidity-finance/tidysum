-- The misallocation ledger: the owner side (the serve loop, CLI and admin page) records it;
-- agents read it for their own user only.
ALTER TABLE misallocation ADD CONSTRAINT misallocation_category_check
  CHECK (category IN ('cash', 'card', 'debt', 'securities'));
--> statement-breakpoint
ALTER TABLE misallocation ADD CONSTRAINT misallocation_state_check
  CHECK (state IN ('open', 'dismissed', 'resolved', 'withdrawn'));
--> statement-breakpoint
ALTER TABLE misallocation ADD CONSTRAINT misallocation_cost_check CHECK (annual_cost >= 0);
--> statement-breakpoint
ALTER TABLE misallocation ADD CONSTRAINT misallocation_decided_check
  CHECK ((state = 'open') = (decided_at IS NULL));
--> statement-breakpoint
ALTER TABLE misallocation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON misallocation USING (user_id = purser_session_user())
  WITH CHECK (user_id = purser_session_user());
--> statement-breakpoint
GRANT SELECT ON misallocation TO purser_agent;

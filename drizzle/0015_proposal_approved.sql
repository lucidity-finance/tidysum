-- The owner can approve an open proposal from the admin page. Approval is recorded, re-checked
-- against the policy and data at that moment; nothing executes (Phase 4). The agent roles still
-- can't update proposals, so only the admin side can approve.
ALTER TABLE proposal DROP CONSTRAINT proposal_state_check;
--> statement-breakpoint
ALTER TABLE proposal ADD CONSTRAINT proposal_state_check
  CHECK (state IN ('proposed', 'blocked', 'approved', 'dismissed'));

-- The Actions queue (decision 0005). Tidysum drafts an action for each open finding, the owner
-- approves it, marks it done, and a later sync confirms it when the finding goes away because it
-- was acted on. steps and snoozed_until are written by the owner side only: the proposer role's
-- column grants on proposal don't include them, so agents can't set them.
ALTER TABLE proposal DROP CONSTRAINT proposal_state_check;
--> statement-breakpoint
ALTER TABLE proposal ADD CONSTRAINT proposal_state_check
  CHECK (state IN ('proposed', 'blocked', 'approved', 'done', 'confirmed', 'dismissed'));
--> statement-breakpoint
ALTER TABLE proposal ADD CONSTRAINT proposal_steps_check
  CHECK (steps IS NULL OR jsonb_typeof(steps) = 'array');

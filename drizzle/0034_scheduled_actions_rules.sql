-- Scheduled actions (decision 0006): an action can wait for a day (not_before) and have a last
-- day it still does its job (due_by). The owner's agent may suggest one with its own steps
-- (schedule_action over MCP), so the proposer role may now write steps and the two dates on a
-- new proposal. The owner still approves every one on the Actions page.
ALTER TABLE proposal ADD CONSTRAINT proposal_schedule_check
  CHECK (due_by IS NULL OR not_before IS NULL OR due_by >= not_before);
--> statement-breakpoint
ALTER TABLE proposal ADD CONSTRAINT proposal_steps_size_check
  CHECK (steps IS NULL OR length(steps::text) <= 20000);
--> statement-breakpoint
GRANT INSERT (steps, not_before, due_by) ON proposal TO tidysum_proposer;

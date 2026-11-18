-- A follow-up check names the action it checks (decision 0006). The owner's agent may add one with
-- schedule_action, so the proposer role may set it on a new proposal; finishing the check is what
-- confirms the action it follows, on the owner side.
ALTER TABLE proposal ADD CONSTRAINT proposal_follow_up_check CHECK (follow_up_of <> id);
--> statement-breakpoint
GRANT INSERT (follow_up_of) ON proposal TO tidysum_proposer;

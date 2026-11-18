-- A partial investment-miner run can be current too, when most of its fetches worked (the
-- importer checks the run's coverage). Failed, interrupted, running and legacy runs still can't.
ALTER TABLE research_run DROP CONSTRAINT research_run_status_check;--> statement-breakpoint
ALTER TABLE research_run ADD CONSTRAINT research_run_status_check
  CHECK (status IN ('completed', 'partial'));

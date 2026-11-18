-- Waiting for calm markets (decision 0008). An action may wait for a condition besides its days;
-- the owner's agent may suggest one (schedule_action), so the proposer role may set it on a new
-- proposal. Market readings are market data, not personal data, so no row-level security (like
-- `security`): the owner side fetches them and agents only read them.
ALTER TABLE proposal ADD CONSTRAINT proposal_wait_for_check
  CHECK (wait_for IS NULL OR wait_for IN ('calm_markets'));
--> statement-breakpoint
GRANT INSERT (wait_for) ON proposal TO tidysum_proposer;
--> statement-breakpoint
ALTER TABLE market_reading ADD CONSTRAINT market_reading_series_check
  CHECK (series IN ('VIXCLS'));
--> statement-breakpoint
ALTER TABLE market_reading ADD CONSTRAINT market_reading_value_check CHECK (value >= 0);
--> statement-breakpoint
GRANT SELECT ON market_reading TO tidysum_agent;

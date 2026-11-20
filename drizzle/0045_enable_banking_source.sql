-- Enable Banking connects UK and EU banks, where Plaid's free plan doesn't reach (decision 0011).
-- Its items keep their session in item_secret like Plaid's access tokens.
ALTER TABLE item DROP CONSTRAINT item_source_check;
--> statement-breakpoint
ALTER TABLE item ADD CONSTRAINT item_source_check CHECK (source IN ('plaid', 'csv', 'enable_banking'));

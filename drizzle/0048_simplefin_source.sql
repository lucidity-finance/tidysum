-- SimpleFIN Bridge connects US banks, cards and brokerages without a Plaid account (decision 0013).
-- Its items keep their access URL in item_secret like Plaid's access tokens.
ALTER TABLE item DROP CONSTRAINT item_source_check;
--> statement-breakpoint
ALTER TABLE item ADD CONSTRAINT item_source_check CHECK (source IN ('plaid', 'csv', 'enable_banking', 'simplefin'));

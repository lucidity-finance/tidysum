-- The Bank of England's SONIA and the ECB's euro short-term rate join the public facts, as the
-- cash yardsticks for users who count in pounds or euros (src/facts/refresh.ts).
ALTER TABLE fact_import DROP CONSTRAINT fact_import_source_check;
--> statement-breakpoint
ALTER TABLE fact_import ADD CONSTRAINT fact_import_source_check
  CHECK (source IN ('sec_funds', 'cfpb_cards', 'treasury', 'bank_of_canada', 'bank_of_england', 'ecb'));
--> statement-breakpoint
ALTER TABLE market_reading DROP CONSTRAINT market_reading_series_check;
--> statement-breakpoint
ALTER TABLE market_reading ADD CONSTRAINT market_reading_series_check
  CHECK (series IN ('VIXCLS', 'TBILL13W', 'CA_TBILL3M', 'GB_SONIA', 'EU_ESTR'));

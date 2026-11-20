-- The Bank of Canada's 3-month treasury bill yield joins the public facts, as the cash yardstick
-- for users in Canada (src/facts/refresh.ts).
ALTER TABLE fact_import DROP CONSTRAINT fact_import_source_check;
--> statement-breakpoint
ALTER TABLE fact_import ADD CONSTRAINT fact_import_source_check
  CHECK (source IN ('sec_funds', 'cfpb_cards', 'treasury', 'bank_of_canada'));
--> statement-breakpoint
ALTER TABLE market_reading DROP CONSTRAINT market_reading_series_check;
--> statement-breakpoint
ALTER TABLE market_reading ADD CONSTRAINT market_reading_series_check
  CHECK (series IN ('VIXCLS', 'TBILL13W', 'CA_TBILL3M'));

-- Public product facts. Fund fees, card terms and the import log are market data, not personal
-- data, so no row-level security (like `security`): the owner side fetches them and agents only
-- read them. Fact checks are shared too, but an agent records them: the proposer role may insert
-- one, and only as its own user.
ALTER TABLE fund_fee ADD CONSTRAINT fund_fee_ratio_check
  CHECK (expense_ratio >= 0 AND expense_ratio < 10
    AND (gross_expense_ratio IS NULL OR (gross_expense_ratio >= 0 AND gross_expense_ratio < 10)));
--> statement-breakpoint
ALTER TABLE card_terms ADD CONSTRAINT card_terms_numbers_check
  CHECK ((annual_fee IS NULL OR annual_fee >= 0)
    AND (foreign_transaction_fee IS NULL OR foreign_transaction_fee >= 0));
--> statement-breakpoint
ALTER TABLE fact_import ADD CONSTRAINT fact_import_source_check
  CHECK (source IN ('sec_funds', 'cfpb_cards', 'treasury'));
--> statement-breakpoint
ALTER TABLE fact_check ADD CONSTRAINT fact_check_kind_check CHECK (kind IN ('deposit', 'card'));
--> statement-breakpoint
ALTER TABLE fact_check ADD CONSTRAINT fact_check_outcome_check
  CHECK (outcome IN ('confirmed', 'changed', 'not_found'));
--> statement-breakpoint
ALTER TABLE fact_check ADD CONSTRAINT fact_check_url_check CHECK (source_url LIKE 'https://%');
--> statement-breakpoint
ALTER TABLE fact_check ADD CONSTRAINT fact_check_quote_check
  CHECK (length(quote) BETWEEN 1 AND 1000);
--> statement-breakpoint
ALTER TABLE market_reading DROP CONSTRAINT market_reading_series_check;
--> statement-breakpoint
ALTER TABLE market_reading ADD CONSTRAINT market_reading_series_check
  CHECK (series IN ('VIXCLS', 'TBILL13W'));
--> statement-breakpoint
GRANT SELECT ON fund_fee, card_terms, fact_import, fact_check TO tidysum_agent;
--> statement-breakpoint
ALTER TABLE fact_check ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY fact_check_read ON fact_check FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY fact_check_insert ON fact_check FOR INSERT
  WITH CHECK (user_id = tidysum_session_user());
--> statement-breakpoint
GRANT INSERT (kind, product_id, outcome, changes, source_url, quote, rates_as_of, checked_on, user_id)
  ON fact_check TO tidysum_proposer;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE fact_check_id_seq TO tidysum_proposer;

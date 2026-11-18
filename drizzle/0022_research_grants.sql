-- investment-miner research evidence. Market research, not personal data, so no row-level
-- security (like `security`); the owner side (`tidysum research import`) writes it and agents
-- only read it. Investment advice from it is gated in code by app_user.investing_enabled.
ALTER TABLE research_run ADD CONSTRAINT research_run_status_check CHECK (status = 'completed');
--> statement-breakpoint
ALTER TABLE research_run ADD CONSTRAINT research_run_product_check
  CHECK (product IN ('institutional', 'assets'));
--> statement-breakpoint
ALTER TABLE research_run ADD CONSTRAINT research_run_schema_check CHECK (export_schema_version = 2);
--> statement-breakpoint
ALTER TABLE research_candidate ADD CONSTRAINT research_candidate_rank_check CHECK (rank >= 1);
--> statement-breakpoint
ALTER TABLE research_candidate ADD CONSTRAINT research_candidate_score_check
  CHECK ((score IS NULL OR score BETWEEN 0 AND 1)
    AND (score_coverage IS NULL OR score_coverage BETWEEN 0 AND 1));
--> statement-breakpoint
GRANT SELECT ON research_run, research_candidate, research_import TO tidysum_agent;

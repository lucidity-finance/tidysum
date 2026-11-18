-- Users that exist before this migration are the operator managing their own money, which is
-- the one case where investment features need no adviser registration (decision 0002).
ALTER TABLE "app_user" ADD COLUMN "investing_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "app_user" SET "investing_enabled" = true;--> statement-breakpoint
ALTER TABLE "proposal" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "proposal" ADD COLUMN "expected_annual_value" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "proposal" ADD COLUMN "finding_key" text;--> statement-breakpoint
UPDATE "proposal" p SET "category" = CASE
  WHEN EXISTS (SELECT FROM proposal_action a WHERE a.proposal_id = p.id AND a.kind = 'trade') THEN 'securities'
  WHEN EXISTS (
    SELECT FROM proposal_action a JOIN account t ON t.id = a.to_account_id
    WHERE a.proposal_id = p.id AND a.kind = 'payment' AND t.type = 'loan'
  ) THEN 'debt'
  WHEN EXISTS (SELECT FROM proposal_action a WHERE a.proposal_id = p.id AND a.kind = 'payment') THEN 'card'
  ELSE 'cash'
END;--> statement-breakpoint
ALTER TABLE "proposal" ALTER COLUMN "category" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_category_check"
  CHECK ("category" IN ('cash', 'card', 'debt', 'securities'));--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_expected_annual_value_check"
  CHECK ("expected_annual_value" IS NULL OR "expected_annual_value" >= 0);--> statement-breakpoint
GRANT INSERT (category, expected_annual_value, finding_key) ON proposal TO purser_proposer;

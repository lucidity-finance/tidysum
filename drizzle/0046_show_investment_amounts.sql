-- Whether the Investments page shows money amounts. Off for everyone, as before: Tidysum shows
-- shares of the mix unless the person asks for the numbers. Agents read it, so the allocation
-- report they get carries amounts only when the person turned them on.
ALTER TABLE "app_user" ADD COLUMN "show_investment_amounts" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
GRANT SELECT (show_investment_amounts) ON app_user TO tidysum_agent;

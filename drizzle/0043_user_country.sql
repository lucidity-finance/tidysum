-- Where each user lives (src/region.ts). Existing users are in the US, where Tidysum began. The
-- code keeps the list of countries; the database only insists on an ISO 3166-1 alpha-2 shape.
-- Agents read it: it decides the currency their findings are in and which advice applies.
ALTER TABLE "app_user" ADD COLUMN "country" text DEFAULT 'US' NOT NULL;
--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_country_check" CHECK (country ~ '^[A-Z]{2}$');
--> statement-breakpoint
GRANT SELECT (country) ON app_user TO tidysum_agent;

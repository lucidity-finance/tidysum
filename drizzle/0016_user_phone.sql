-- The phone number Plaid Link pre-fills for a returning user. It's contact data the agent has no
-- use for, so tidysum_agent's grant on app_user narrows to the columns it can already read,
-- minus the new one.
ALTER TABLE "app_user" ADD COLUMN "phone_number" text;
--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_phone_number_check"
  CHECK (phone_number ~ '^\+[1-9][0-9]{7,14}$');
--> statement-breakpoint
REVOKE SELECT ON app_user FROM tidysum_agent;
--> statement-breakpoint
GRANT SELECT (id, display_name, investing_enabled, plaid_user_id, created_at) ON app_user TO tidysum_agent;

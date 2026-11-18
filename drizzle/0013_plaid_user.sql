ALTER TABLE "app_user" ADD COLUMN "plaid_user_id" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_plaid_user_id_unique" UNIQUE("plaid_user_id");
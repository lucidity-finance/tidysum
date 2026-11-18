CREATE TABLE "misallocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"category" text NOT NULL,
	"detector" text NOT NULL,
	"summary" text NOT NULL,
	"annual_cost" numeric(19, 4) NOT NULL,
	"account_ids" uuid[] NOT NULL,
	"product_id" text,
	"action" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"realized_annual_value" numeric(19, 4),
	"realized_basis" text,
	CONSTRAINT "misallocation_user_key_unique" UNIQUE("user_id","key")
);
--> statement-breakpoint
ALTER TABLE "misallocation" ADD CONSTRAINT "misallocation_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;
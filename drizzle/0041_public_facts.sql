CREATE TABLE "card_terms" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"institution" text NOT NULL,
	"product" text NOT NULL,
	"report_date" date NOT NULL,
	"national" boolean NOT NULL,
	"secured" boolean NOT NULL,
	"annual_fee" numeric(19, 4),
	"purchase_apr_min" numeric(6, 2),
	"purchase_apr_median" numeric(6, 2),
	"purchase_apr_max" numeric(6, 2),
	"intro_apr" boolean NOT NULL,
	"foreign_transaction_fee" numeric(5, 2),
	"rewards" text,
	"credit_tiers" text,
	"website" text,
	"source_url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_check" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"product_id" text NOT NULL,
	"outcome" text NOT NULL,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_url" text NOT NULL,
	"quote" text NOT NULL,
	"rates_as_of" date,
	"checked_on" date NOT NULL,
	"user_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_import" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"file" text,
	"ok" boolean NOT NULL,
	"rows" integer DEFAULT 0 NOT NULL,
	"error" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fund_fee" (
	"class_id" text PRIMARY KEY NOT NULL,
	"series_id" text NOT NULL,
	"ticker" text NOT NULL,
	"fund_name" text NOT NULL,
	"class_name" text,
	"expense_ratio" numeric(7, 4) NOT NULL,
	"gross_expense_ratio" numeric(7, 4),
	"as_of" date NOT NULL,
	"filed" date NOT NULL,
	"source_url" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fact_check" ADD CONSTRAINT "fact_check_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fact_check_product_idx" ON "fact_check" USING btree ("kind","product_id","at");--> statement-breakpoint
CREATE INDEX "fact_import_source_idx" ON "fact_import" USING btree ("source","at");--> statement-breakpoint
CREATE INDEX "fund_fee_ticker_idx" ON "fund_fee" USING btree ("ticker");
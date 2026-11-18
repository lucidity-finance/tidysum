CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"plaid_account_id" text,
	"name" text NOT NULL,
	"official_name" text,
	"type" text NOT NULL,
	"subtype" text,
	"mask" text,
	"currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_plaid_account_id_unique" UNIQUE("plaid_account_id")
);
--> statement-breakpoint
CREATE TABLE "balance_snapshot" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"current" numeric(19, 4),
	"available" numeric(19, 4),
	"credit_limit" numeric(19, 4),
	"currency" text,
	"as_of" timestamp with time zone NOT NULL,
	CONSTRAINT "balance_snapshot_account_id_as_of_unique" UNIQUE("account_id","as_of")
);
--> statement-breakpoint
CREATE TABLE "holding" (
	"account_id" uuid NOT NULL,
	"security_id" text NOT NULL,
	"quantity" numeric(28, 10) NOT NULL,
	"institution_price" numeric(28, 10) NOT NULL,
	"institution_value" numeric(19, 4) NOT NULL,
	"cost_basis" numeric(19, 4),
	"currency" text,
	"as_of" timestamp with time zone NOT NULL,
	CONSTRAINT "holding_account_id_security_id_pk" PRIMARY KEY("account_id","security_id")
);
--> statement-breakpoint
CREATE TABLE "item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"plaid_item_id" text,
	"institution_id" text,
	"institution_name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"status_detail" text,
	"transactions_cursor" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_plaid_item_id_unique" UNIQUE("plaid_item_id")
);
--> statement-breakpoint
CREATE TABLE "item_secret" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"access_token_ciphertext" "bytea" NOT NULL,
	"key_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "liability" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"apr_percentage" numeric(9, 4),
	"last_statement_balance" numeric(19, 4),
	"minimum_payment" numeric(19, 4),
	"next_payment_due_date" date,
	"is_overdue" boolean,
	"as_of" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"ticker_symbol" text,
	"type" text,
	"is_cash_equivalent" boolean,
	"close_price" numeric(28, 10),
	"close_price_as_of" date,
	"currency" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_run" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"added" integer DEFAULT 0 NOT NULL,
	"modified" integer DEFAULT 0 NOT NULL,
	"removed" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"plaid_transaction_id" text,
	"date" date NOT NULL,
	"authorized_date" date,
	"amount" numeric(19, 4) NOT NULL,
	"currency" text,
	"name" text,
	"merchant_name" text,
	"category_primary" text,
	"category_detailed" text,
	"pending" boolean NOT NULL,
	"pending_transaction_id" text,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_plaid_transaction_id_unique" UNIQUE("plaid_transaction_id")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_snapshot" ADD CONSTRAINT "balance_snapshot_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding" ADD CONSTRAINT "holding_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holding" ADD CONSTRAINT "holding_security_id_security_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."security"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_secret" ADD CONSTRAINT "item_secret_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liability" ADD CONSTRAINT "liability_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_account_date_idx" ON "transaction" USING btree ("account_id","date");
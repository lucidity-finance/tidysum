-- Multi-tenancy: every row of personal data belongs to an app_user.
-- Hand-ordered from drizzle-kit's output so it can run on a populated database: columns are
-- added nullable, backfilled to the first user, then made NOT NULL; uniques before the
-- composite foreign keys that reference them.
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- A local install has exactly one user to begin with; existing rows become theirs.
INSERT INTO app_user (display_name) SELECT 'Owner' WHERE NOT EXISTS (SELECT FROM app_user);
--> statement-breakpoint
ALTER TABLE "account" DROP CONSTRAINT "account_item_id_item_id_fk";
--> statement-breakpoint
ALTER TABLE "balance_snapshot" DROP CONSTRAINT "balance_snapshot_account_id_account_id_fk";
--> statement-breakpoint
ALTER TABLE "holding" DROP CONSTRAINT "holding_account_id_account_id_fk";
--> statement-breakpoint
ALTER TABLE "liability" DROP CONSTRAINT "liability_account_id_account_id_fk";
--> statement-breakpoint
ALTER TABLE "proposal" DROP CONSTRAINT "proposal_policy_version_id_policy_version_id_fk";
--> statement-breakpoint
ALTER TABLE "proposal_action" DROP CONSTRAINT "proposal_action_proposal_id_proposal_id_fk";
--> statement-breakpoint
ALTER TABLE "proposal_action" DROP CONSTRAINT "proposal_action_from_account_id_account_id_fk";
--> statement-breakpoint
ALTER TABLE "proposal_action" DROP CONSTRAINT "proposal_action_to_account_id_account_id_fk";
--> statement-breakpoint
ALTER TABLE "sync_run" DROP CONSTRAINT "sync_run_item_id_item_id_fk";
--> statement-breakpoint
ALTER TABLE "transaction" DROP CONSTRAINT "transaction_account_id_account_id_fk";
--> statement-breakpoint
ALTER TABLE "item" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "balance_snapshot" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "holding" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "liability" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "sync_run" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "policy_version" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "proposal" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "proposal_action" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "audit_event" ADD COLUMN "user_id" uuid;
--> statement-breakpoint
ALTER TABLE "audit_event" DISABLE TRIGGER audit_event_append_only;
--> statement-breakpoint
UPDATE "item" SET "user_id" = (SELECT id FROM app_user ORDER BY created_at LIMIT 1);
--> statement-breakpoint
UPDATE "account" SET "user_id" = (SELECT id FROM app_user ORDER BY created_at LIMIT 1);
--> statement-breakpoint
UPDATE "balance_snapshot" SET "user_id" = (SELECT id FROM app_user ORDER BY created_at LIMIT 1);
--> statement-breakpoint
UPDATE "transaction" SET "user_id" = (SELECT id FROM app_user ORDER BY created_at LIMIT 1);
--> statement-breakpoint
UPDATE "holding" SET "user_id" = (SELECT id FROM app_user ORDER BY created_at LIMIT 1);
--> statement-breakpoint
UPDATE "liability" SET "user_id" = (SELECT id FROM app_user ORDER BY created_at LIMIT 1);
--> statement-breakpoint
UPDATE "sync_run" SET "user_id" = (SELECT id FROM app_user ORDER BY created_at LIMIT 1);
--> statement-breakpoint
UPDATE "policy_version" SET "user_id" = (SELECT id FROM app_user ORDER BY created_at LIMIT 1);
--> statement-breakpoint
UPDATE "proposal" SET "user_id" = (SELECT id FROM app_user ORDER BY created_at LIMIT 1);
--> statement-breakpoint
UPDATE "proposal_action" SET "user_id" = (SELECT id FROM app_user ORDER BY created_at LIMIT 1);
--> statement-breakpoint
UPDATE "audit_event" SET "user_id" = (SELECT id FROM app_user ORDER BY created_at LIMIT 1);
--> statement-breakpoint
ALTER TABLE "audit_event" ENABLE TRIGGER audit_event_append_only;
--> statement-breakpoint
ALTER TABLE "item" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "balance_snapshot" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "transaction" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "holding" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "liability" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "sync_run" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "policy_version" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "proposal" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "proposal_action" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_event" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "policy_version" ADD COLUMN "activated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "policy_version" DROP CONSTRAINT "policy_version_pkey";
--> statement-breakpoint
ALTER TABLE "policy_version" ADD CONSTRAINT "policy_version_user_id_id_pk" PRIMARY KEY("user_id","id");
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_id_user_unique" UNIQUE("id","user_id");
--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_id_user_unique" UNIQUE("id","user_id");
--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_id_user_unique" UNIQUE("id","user_id");
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_item_fk" FOREIGN KEY ("item_id","user_id") REFERENCES "public"."item"("id","user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "balance_snapshot" ADD CONSTRAINT "balance_snapshot_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "balance_snapshot" ADD CONSTRAINT "balance_snapshot_account_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."account"("id","user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "holding" ADD CONSTRAINT "holding_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "holding" ADD CONSTRAINT "holding_account_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."account"("id","user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "liability" ADD CONSTRAINT "liability_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "liability" ADD CONSTRAINT "liability_account_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."account"("id","user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "policy_version" ADD CONSTRAINT "policy_version_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_policy_version_fk" FOREIGN KEY ("user_id","policy_version_id") REFERENCES "public"."policy_version"("user_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proposal_action" ADD CONSTRAINT "proposal_action_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proposal_action" ADD CONSTRAINT "proposal_action_proposal_fk" FOREIGN KEY ("proposal_id","user_id") REFERENCES "public"."proposal"("id","user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proposal_action" ADD CONSTRAINT "proposal_action_from_account_fk" FOREIGN KEY ("from_account_id","user_id") REFERENCES "public"."account"("id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proposal_action" ADD CONSTRAINT "proposal_action_to_account_fk" FOREIGN KEY ("to_account_id","user_id") REFERENCES "public"."account"("id","user_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_item_fk" FOREIGN KEY ("item_id","user_id") REFERENCES "public"."item"("id","user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_account_fk" FOREIGN KEY ("account_id","user_id") REFERENCES "public"."account"("id","user_id") ON DELETE cascade ON UPDATE no action;

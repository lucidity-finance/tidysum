CREATE TABLE "audit_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"event" text NOT NULL,
	"proposal_id" uuid,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_version" (
	"id" text PRIMARY KEY NOT NULL,
	"content" jsonb NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposal" (
	"id" uuid PRIMARY KEY NOT NULL,
	"policy_version_id" text NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"rationale" text NOT NULL,
	"state" text NOT NULL,
	"validation" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "proposal_action" (
	"proposal_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"from_account_id" uuid,
	"to_account_id" uuid,
	"side" text,
	"symbol" text,
	"amount" numeric(19, 4) NOT NULL,
	CONSTRAINT "proposal_action_proposal_id_seq_pk" PRIMARY KEY("proposal_id","seq")
);
--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_policy_version_id_policy_version_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."policy_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_action" ADD CONSTRAINT "proposal_action_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_action" ADD CONSTRAINT "proposal_action_from_account_id_account_id_fk" FOREIGN KEY ("from_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_action" ADD CONSTRAINT "proposal_action_to_account_id_account_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;
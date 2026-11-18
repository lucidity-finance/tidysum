CREATE TABLE "research_candidate" (
	"run_id" text NOT NULL,
	"rank" integer NOT NULL,
	"ticker" text NOT NULL,
	"name" text,
	"score" numeric,
	"score_coverage" numeric,
	"summary" text NOT NULL,
	"evidence" jsonb NOT NULL,
	CONSTRAINT "research_candidate_run_id_rank_pk" PRIMARY KEY("run_id","rank")
);
--> statement-breakpoint
CREATE TABLE "research_import" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"attempts" jsonb NOT NULL,
	"imported" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_run" (
	"run_id" text PRIMARY KEY NOT NULL,
	"product" text NOT NULL,
	"watchlist" text NOT NULL,
	"status" text NOT NULL,
	"scoring_version" text,
	"export_schema_version" integer NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"limitations" jsonb NOT NULL,
	"warnings" jsonb NOT NULL,
	"coverage" jsonb,
	"signal_count" integer NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "research_candidate" ADD CONSTRAINT "research_candidate_run_id_research_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."research_run"("run_id") ON DELETE cascade ON UPDATE no action;
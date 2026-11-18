CREATE TABLE "market_reading" (
	"series" text NOT NULL,
	"day" date NOT NULL,
	"value" numeric(12, 4) NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_reading_series_day_pk" PRIMARY KEY("series","day")
);
--> statement-breakpoint
ALTER TABLE "proposal" ADD COLUMN "wait_for" text;
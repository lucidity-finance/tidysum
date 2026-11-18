ALTER TABLE "proposal" ADD COLUMN "steps" jsonb;--> statement-breakpoint
ALTER TABLE "proposal" ADD COLUMN "snoozed_until" date;
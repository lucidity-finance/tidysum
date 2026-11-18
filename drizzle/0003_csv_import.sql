ALTER TABLE "transaction" ADD COLUMN "csv_fingerprint" text;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_csv_fingerprint_unique" UNIQUE("csv_fingerprint");
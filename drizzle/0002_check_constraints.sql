-- drizzle's text enums are type-level only; enforce them in the database too.
ALTER TABLE item ADD CONSTRAINT item_source_check CHECK (source IN ('plaid', 'csv'));
--> statement-breakpoint
ALTER TABLE item ADD CONSTRAINT item_status_check
  CHECK (status IN ('active', 'relink_required', 'error', 'disconnected'));
--> statement-breakpoint
ALTER TABLE liability ADD CONSTRAINT liability_kind_check
  CHECK (kind IN ('credit', 'mortgage', 'student'));
--> statement-breakpoint
ALTER TABLE sync_run ADD CONSTRAINT sync_run_status_check
  CHECK (status IN ('running', 'succeeded', 'failed'));

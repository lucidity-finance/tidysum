-- Holdings the owner enters by hand. The owner side (CLI) writes them; agents read their own
-- user's rows only.
ALTER TABLE manual_holding ADD CONSTRAINT manual_holding_value_check CHECK (value >= 0);
--> statement-breakpoint
ALTER TABLE manual_holding ADD CONSTRAINT manual_holding_class_check
  CHECK (asset_class ~ '^[a-z][a-z0-9_]{0,39}$');
--> statement-breakpoint
ALTER TABLE manual_holding ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON manual_holding USING (user_id = tidysum_session_user())
  WITH CHECK (user_id = tidysum_session_user());
--> statement-breakpoint
GRANT SELECT ON manual_holding TO tidysum_agent;

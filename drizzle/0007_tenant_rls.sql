-- Row-level security for the agent roles. Their sessions start with -c purser.user_id=<uuid>;
-- every policy compares against it, and an unset value matches nothing (fail closed).
-- The table owner (sync, admin) is not subject to RLS and writes user_id explicitly.
CREATE FUNCTION purser_session_user() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('purser.user_id', true), '')::uuid
$$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['item', 'account', 'balance_snapshot', 'transaction', 'holding',
    'liability', 'sync_run', 'policy_version', 'proposal', 'proposal_action', 'audit_event']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (user_id = purser_session_user()) '
      'WITH CHECK (user_id = purser_session_user())', t);
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app_user USING (id = purser_session_user());
--> statement-breakpoint
GRANT SELECT ON app_user TO purser_agent;
--> statement-breakpoint
GRANT SELECT (user_id) ON item TO purser_agent;
--> statement-breakpoint
-- Policies are managed by the owner side now (purser policy set), not inserted by agents.
REVOKE INSERT ON policy_version FROM purser_proposer;
--> statement-breakpoint
GRANT INSERT (user_id) ON proposal TO purser_proposer;

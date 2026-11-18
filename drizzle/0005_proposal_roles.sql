-- Phase 3 grants and constraints.
--
-- purser_agent (read-only) may read policies and proposals.
-- purser_proposer is the only other agent-facing role: it inherits purser_agent's reads and may
-- INSERT policies, proposals and audit events, nothing else. No UPDATE or DELETE anywhere, and no
-- access to decided_at, which only the admin side sets.
ALTER TABLE proposal ADD CONSTRAINT proposal_state_check
  CHECK (state IN ('proposed', 'blocked', 'dismissed'));
--> statement-breakpoint
ALTER TABLE proposal_action ADD CONSTRAINT proposal_action_kind_check
  CHECK (kind IN ('transfer', 'payment', 'trade'));
--> statement-breakpoint
ALTER TABLE proposal_action ADD CONSTRAINT proposal_action_shape_check CHECK (
  amount > 0 AND CASE kind
    WHEN 'trade' THEN from_account_id IS NOT NULL AND to_account_id IS NULL
      AND side IN ('buy', 'sell') AND symbol IS NOT NULL
    ELSE from_account_id IS NOT NULL AND to_account_id IS NOT NULL
      AND from_account_id <> to_account_id AND side IS NULL AND symbol IS NULL
  END
);
--> statement-breakpoint
CREATE FUNCTION audit_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_append_only();
--> statement-breakpoint
GRANT SELECT ON policy_version, proposal, proposal_action, audit_event TO purser_agent;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'purser_proposer') THEN
    CREATE ROLE purser_proposer NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT purser_agent TO purser_proposer;
--> statement-breakpoint
GRANT INSERT ON policy_version, proposal_action, audit_event TO purser_proposer;
--> statement-breakpoint
GRANT INSERT (id, policy_version_id, source, title, rationale, state, validation)
  ON proposal TO purser_proposer;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE audit_event_id_seq TO purser_proposer;

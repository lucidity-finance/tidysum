-- The product is called Tidysum now (decision 0004), so the agent roles, their session setting
-- and the function every row-level security policy calls take that name. Policies and grants
-- point at roles and functions by id, so renaming them changes nothing else.
ALTER ROLE purser_agent RENAME TO tidysum_agent;
--> statement-breakpoint
ALTER ROLE purser_proposer RENAME TO tidysum_proposer;
--> statement-breakpoint
ALTER FUNCTION purser_session_user() RENAME TO tidysum_session_user;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION tidysum_session_user() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('tidysum.user_id', true), '')::uuid
$$;

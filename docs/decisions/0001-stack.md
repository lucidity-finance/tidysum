# 0001: TypeScript and Postgres, no Temporal, no fork

Date: 2026-10-30
Status: accepted (the owner: "we aren't forking anything", suggested TypeScript without Temporal)

## Decision

- **TypeScript (strict) on Node 22+** throughout.
- **Postgres** with **Drizzle** for schema and migrations.
- Official **`plaid`** Node client behind a small gateway interface.
- **`@modelcontextprotocol/sdk`** for both Tidysum's own MCP server (Phase 2) and the
  client side of the Robinhood Agentic Trading MCP (Phase 4).
- **Hono** for the small HTTP surface (Plaid Link page, webhooks, approval UI).
- **zod** at every boundary (env, HTTP, MCP tool input).
- **No fork** of Ledgr or Fino. The Plaid surface Tidysum needs is small.
- **No Temporal.** The approval workflow is a Postgres state machine.

## Why not Temporal

The handoff doc recommended one Temporal workflow per proposal. For a single user that
means running a Temporal cluster on an always-on box just to wait for an approval click.
What the workflow actually needs is:

1. durable "waiting on the owner" state,
2. execution with an idempotency key per action,
3. on an ambiguous broker result, query the broker before retrying,
4. reconcile against the next Plaid sync.

All four fit in Postgres: `proposal` and `execution` tables with explicit states, a unique
idempotency key, a single worker loop that claims due work with `FOR UPDATE SKIP LOCKED`,
and an append-only audit log. If Phase 4 grows enough steps to want durable execution, DBOS
or pg-boss run on the same Postgres without a separate cluster.

What we give up: Temporal's replay semantics and its history UI. The audit log covers most
of the history use case.

## Why TypeScript

Plaid's official client, the reference MCP SDK, and the agent SDKs are all TypeScript-first,
and one language keeps the schema, the MCP tool schemas and the UI types in one place.
Kotlin with the Temporal Java SDK was the alternative.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { auditEvent, proposal } from "../db/schema.js";
import type { AgentDb } from "../mcp/agentDb.js";
import type { ProposedAction, Validation } from "./engine.js";
import { type ProposalCategory, proposalCategory, validateProposal } from "./engine.js";
import type { LoadedPolicy } from "./policy.js";
import { readSnapshot } from "./snapshot.js";
import { loadActivePolicy } from "./store.js";

export interface ProposalInput {
  title: string;
  rationale: string;
  actions: ProposedAction[];
  /** Expected yearly savings or earnings, a decimal string; omit when it can't be quantified. */
  expected_annual_value?: string | undefined;
  /** The check_policy finding (its key) this proposal fixes. */
  finding_key?: string | undefined;
}

export interface CreatedProposal {
  proposal_id: string;
  state: "proposed" | "blocked";
  category: ProposalCategory;
  policy_version: string;
  validation: Validation;
}

/**
 * Validates a proposal against the policy and the latest synced data, then stores it with its
 * verdict and an audit event, in one transaction. Runs as tidysum_proposer for one user, which
 * can insert these rows for that user and nothing else. Nothing executes.
 */
export async function createProposal(
  proposer: AgentDb,
  loaded: LoadedPolicy,
  input: ProposalInput,
  source: string,
  today: string,
): Promise<CreatedProposal> {
  const snapshot = await readSnapshot(proposer, today);
  const validation = validateProposal(loaded.policy, snapshot, input.actions);
  const state = validation.violations.length ? "blocked" : "proposed";
  const category = proposalCategory(snapshot, input.actions);
  const id = randomUUID();

  const client = await proposer.connect();
  try {
    await client.query("begin");
    await client.query(
      // user_id comes from the session, the same value row-level security checks against.
      `insert into proposal
         (id, user_id, policy_version_id, source, title, rationale, state, validation,
          category, expected_annual_value, finding_key)
       values ($1, tidysum_session_user(), $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10)`,
      [
        id,
        loaded.versionId,
        source,
        input.title,
        input.rationale,
        state,
        validation,
        category,
        input.expected_annual_value ?? null,
        input.finding_key ?? null,
      ],
    );
    for (const [i, a] of input.actions.entries()) {
      await client.query(
        `insert into proposal_action
           (user_id, proposal_id, seq, kind, from_account_id, to_account_id, side, symbol, amount)
         values (tidysum_session_user(), $1, $2, $3, $4, $5, $6, $7, $8::numeric)`,
        [
          id,
          i + 1,
          a.kind,
          a.from_account_id,
          a.to_account_id ?? null,
          a.side ?? null,
          a.symbol?.toUpperCase() ?? null,
          a.amount,
        ],
      );
    }
    await client.query(
      `insert into audit_event (user_id, actor, event, proposal_id, data)
       values (tidysum_session_user(), $1, 'proposal.created', $2, $3)`,
      // The evidence: the exact data the proposal was checked against, kept with the decision.
      [
        source,
        id,
        {
          state,
          category,
          policy_version: loaded.versionId,
          ...input,
          validation,
          evidence: snapshot,
        },
      ],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return { proposal_id: id, state, category, policy_version: loaded.versionId, validation };
}

export async function listProposals(
  db: AgentDb,
  opts: { state?: string | undefined; limit: number },
) {
  const { rows } = await db.query(
    `select p.id, p.title, p.rationale, p.state, p.category,
       p.expected_annual_value::text as expected_annual_value, p.finding_key, p.source,
       p.policy_version_id, p.validation,
       p.created_at, p.decided_at,
       coalesce((
         select json_agg(json_build_object(
           'seq', a.seq, 'kind', a.kind, 'from_account_id', a.from_account_id,
           'from_account', fa.name, 'to_account_id', a.to_account_id, 'to_account', ta.name,
           'side', a.side, 'symbol', a.symbol, 'amount', a.amount::text) order by a.seq)
         from proposal_action a
         left join account fa on fa.id = a.from_account_id
         left join account ta on ta.id = a.to_account_id
         where a.proposal_id = p.id
       ), '[]') as actions
     from proposal p
     where $1::text is null or p.state = $1
     order by p.created_at desc
     limit $2`,
    [opts.state ?? null, opts.limit],
  );
  return { proposals: rows };
}

export type Approval =
  | { approved: true; policy_version: string; validation: Validation }
  | { approved: false; reason: "not_open" }
  | { approved: false; reason: "blocked_now"; validation: Validation };

/**
 * The owner says yes to an open proposal. It is checked again against the active policy and the
 * latest synced data, because balances move between proposing and approving; if it breaks a
 * limit now it stays open, and the refusal is logged with its evidence. Otherwise it becomes
 * `approved`, with the evidence in the audit log. Nothing executes: that is Phase 4, which must
 * check once more before moving anything.
 */
export async function approveProposal(
  db: Db,
  agentDb: AgentDb,
  userId: string,
  id: string,
  today: string,
  actor: string,
): Promise<Approval> {
  const { rows } = await agentDb.query<{ state: string; guided: boolean }>(
    "select state, jsonb_array_length(coalesce(steps, '[]')) > 0 as guided from proposal where id = $1",
    [id],
  );
  if (rows[0]?.state !== "proposed") return { approved: false, reason: "not_open" };
  const { rows: actions } = await agentDb.query<ProposedAction>(
    `select kind, from_account_id, to_account_id, side, symbol, amount::text as amount
       from proposal_action where proposal_id = $1 order by seq`,
    [id],
  );
  const loaded = await loadActivePolicy(agentDb);
  const snapshot = await readSnapshot(agentDb, today);
  const validation = validateProposal(
    loaded.policy,
    snapshot,
    actions.map((a) => ({
      kind: a.kind,
      from_account_id: a.from_account_id,
      ...(a.to_account_id ? { to_account_id: a.to_account_id } : {}),
      ...(a.side ? { side: a.side } : {}),
      ...(a.symbol ? { symbol: a.symbol } : {}),
      amount: a.amount,
    })),
    { guided: rows[0].guided },
  );
  const evidence = { policy_version: loaded.versionId, validation, evidence: snapshot };

  if (validation.violations.length) {
    await db.insert(auditEvent).values({
      userId,
      actor,
      event: "proposal.approval_refused",
      proposalId: id,
      data: evidence,
    });
    return { approved: false, reason: "blocked_now", validation };
  }

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(proposal)
      .set({ state: "approved", decidedAt: new Date() })
      .where(and(eq(proposal.id, id), eq(proposal.userId, userId), eq(proposal.state, "proposed")))
      .returning({ id: proposal.id });
    if (updated.length === 0) return { approved: false as const, reason: "not_open" as const };
    await tx.insert(auditEvent).values({
      userId,
      actor,
      event: "proposal.approved",
      proposalId: id,
      data: evidence,
    });
    return { approved: true as const, policy_version: loaded.versionId, validation };
  });
}

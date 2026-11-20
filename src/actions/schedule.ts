import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import {
  appUser,
  auditEvent,
  policyVersion,
  proposal,
  proposalCategory,
  proposalWaitFor,
} from "../db/schema.js";
import type { AgentDb } from "../mcp/agentDb.js";
import type { LoadedPolicy } from "../policy/policy.js";
import { type Action, listActions } from "./actions.js";
import { checkNote } from "./agentRun.js";

// Scheduled actions (decision 0006). Some fixes have a day: next year's 401(k) percent can only be
// set after this year's last payday, and a paystub can only be checked once it's out. An action
// can carry the first day it may be carried out (not_before) and the last day it still does its
// job (due_by). The owner approves it whenever they like, ahead of time included; an approved
// action waits under Scheduled until its first day, then joins the work in progress. Nothing here
// approves anything: the owner's yes holds until they take it back.
//
// Agents act only when asked, so Tidysum itself watches the days: `checkSchedule` runs every hour
// while `tidysum serve` runs. It notes in the audit log when an action comes due, is about to
// run out of time, or did; tells the owner (a notification on their computer); and, if the owner
// set TIDYSUM_AGENT_COMMAND, starts their own agent on an approved action that's due.

const day = z.iso.date();
const money = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, "must be a decimal string like 120.00");

const Step = z
  .object({
    text: z.string().trim().min(3).max(500),
    by: z.enum(["agent", "you"]),
    needs_you: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const ScheduleInput = z
  .object({
    title: z.string().trim().min(3).max(120),
    rationale: z.string().trim().min(10).max(4000),
    category: z.enum(proposalCategory),
    steps: z.array(Step).min(1).max(20),
    /** The first day it may be carried out. */
    not_before: day.optional(),
    /** The last day it still does its job. */
    due_by: day.optional(),
    expected_annual_value: money.optional(),
    /** The finding it fixes or follows up on; it may not be in the ledger (yet). */
    finding_key: z.string().trim().min(1).max(200).optional(),
    /**
     * The approved or done action this one checks, by id or by its finding key: finishing the
     * check confirms it, for changes no sync can see (a 401(k) election).
     */
    follows_up: z.string().trim().min(1).max(200).optional(),
    /**
     * A condition to wait for besides the days (decision 0008): `calm_markets` holds it until
     * the VIX has been calm for a few closes, for a sale that leaves money out of the market.
     */
    wait_for: z.enum(proposalWaitFor).optional(),
  })
  .strict()
  .refine((s) => s.not_before || s.due_by || s.wait_for, "give not_before, due_by or wait_for")
  .refine(
    (s) => !s.not_before || !s.due_by || s.due_by >= s.not_before,
    "due_by can't be before not_before",
  );
export type ScheduleInput = z.infer<typeof ScheduleInput>;

export class ScheduleRefused extends Error {}

export function parseSchedule(json: unknown): ScheduleInput {
  const r = ScheduleInput.safeParse(json);
  if (!r.success) {
    throw new ScheduleRefused(
      `invalid scheduled action: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    );
  }
  return r.data;
}

/** Live actions one user may have waiting on a day, so a runaway agent can't flood the queue. */
const MAX_SCHEDULED = 50;

function check(input: ScheduleInput, today: string, investing: boolean, waiting: number) {
  if (input.due_by && input.due_by < today) {
    throw new ScheduleRefused(`due_by ${input.due_by} has already passed.`);
  }
  if (input.category === "securities" && !investing) {
    throw new ScheduleRefused(
      "Investment actions are only for users who have investing turned on.",
    );
  }
  if (waiting >= MAX_SCHEDULED) {
    throw new ScheduleRefused(`There are already ${waiting} scheduled actions waiting.`);
  }
  // Notes and steps never carry secrets (decision 0005); the same rule as an agent's reports.
  for (const s of input.steps) checkNote(s.text);
}

const VALIDATION = { violations: [], warnings: [], numbers: {} };

/** The action a follow-up checks: by id, or the newest approved or done one for a finding key. */
const FOLLOWED = `select id from proposal
  where (id::text = $1 or finding_key = $1) and state in ('approved', 'done', 'confirmed')
  order by created_at desc limit 1`;

const notFollowable = (ref: string) =>
  new ScheduleRefused(
    `No approved, done or confirmed action ${ref} to follow up; use an id from list_actions.`,
  );

export interface Scheduled {
  id: string;
  state: "proposed";
  not_before: string | null;
  due_by: string | null;
  next: string;
}

const NEXT =
  "Waiting for the owner on Tidysum's Actions page. They can approve it now; it waits under Scheduled until its first day.";

/** The owner side (the CLI): stores a scheduled action for the owner to approve. */
export async function scheduleAction(
  db: Db,
  userId: string,
  input: ScheduleInput,
  source: string,
  today: string,
  now = new Date(),
): Promise<Scheduled> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ investing: appUser.investingEnabled })
      .from(appUser)
      .where(eq(appUser.id, userId));
    if (!user) throw new ScheduleRefused(`no user ${userId}`);
    const live = await tx
      .select({ id: proposal.id, notBefore: proposal.notBefore, dueBy: proposal.dueBy })
      .from(proposal)
      .where(and(eq(proposal.userId, userId), inArray(proposal.state, ["proposed", "approved"])));
    check(input, today, user.investing, live.filter((p) => p.notBefore || p.dueBy).length);
    const [policy] = await tx
      .select({ id: policyVersion.id })
      .from(policyVersion)
      .where(eq(policyVersion.userId, userId))
      .orderBy(desc(policyVersion.activatedAt))
      .limit(1);
    if (!policy) throw new ScheduleRefused("No policy yet: run `tidysum policy set` first.");
    let followUpOf: string | null = null;
    if (input.follows_up) {
      const [row] = await tx
        .select({ id: proposal.id })
        .from(proposal)
        .where(
          and(
            eq(proposal.userId, userId),
            inArray(proposal.state, ["approved", "done", "confirmed"]),
            or(
              sql`${proposal.id}::text = ${input.follows_up}`,
              eq(proposal.findingKey, input.follows_up),
            ),
          ),
        )
        .orderBy(desc(proposal.createdAt))
        .limit(1);
      if (!row) throw notFollowable(input.follows_up);
      followUpOf = row.id;
    }
    const id = randomUUID();
    await tx.insert(proposal).values({
      id,
      userId,
      policyVersionId: policy.id,
      source,
      state: "proposed",
      title: input.title,
      rationale: input.rationale,
      category: input.category,
      expectedAnnualValue: input.expected_annual_value ?? null,
      findingKey: input.finding_key ?? null,
      validation: VALIDATION,
      steps: input.steps,
      notBefore: input.not_before ?? null,
      dueBy: input.due_by ?? null,
      waitFor: input.wait_for ?? null,
      followUpOf,
      createdAt: now,
    });
    await tx.insert(auditEvent).values({
      userId,
      at: now,
      actor: source,
      event: "proposal.created",
      proposalId: id,
      data: {
        state: "proposed",
        policy_version: policy.id,
        scheduled: true,
        ...input,
        follow_up_of: followUpOf,
      },
    });
    return {
      id,
      state: "proposed" as const,
      not_before: input.not_before ?? null,
      due_by: input.due_by ?? null,
      next: NEXT,
    };
  });
}

/** An agent's suggestion over MCP (schedule_action), as tidysum_proposer for one user. */
export async function scheduleActionAsAgent(
  proposer: AgentDb,
  loaded: LoadedPolicy,
  input: ScheduleInput,
  source: string,
  today: string,
): Promise<Scheduled> {
  const { rows: user } = await proposer.query<{ investing_enabled: boolean }>(
    "select investing_enabled from app_user",
  );
  const { rows: live } = await proposer.query<{ n: number }>(
    `select count(*)::int as n from proposal
      where state in ('proposed', 'approved') and (not_before is not null or due_by is not null)`,
  );
  check(input, today, user[0]?.investing_enabled ?? false, live[0]?.n ?? 0);
  let followUpOf: string | null = null;
  if (input.follows_up) {
    const { rows } = await proposer.query<{ id: string }>(FOLLOWED, [input.follows_up]);
    if (!rows[0]) throw notFollowable(input.follows_up);
    followUpOf = rows[0].id;
  }
  const id = randomUUID();
  const client = await proposer.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into proposal
         (id, user_id, policy_version_id, source, title, rationale, state, validation, category,
          expected_annual_value, finding_key, steps, not_before, due_by, follow_up_of, wait_for)
       values ($1, tidysum_session_user(), $2, $3, $4, $5, 'proposed', $6, $7, $8::numeric, $9,
               $10, $11, $12, $13, $14)`,
      [
        id,
        loaded.versionId,
        source,
        input.title,
        input.rationale,
        VALIDATION,
        input.category,
        input.expected_annual_value ?? null,
        input.finding_key ?? null,
        JSON.stringify(input.steps),
        input.not_before ?? null,
        input.due_by ?? null,
        followUpOf,
        input.wait_for ?? null,
      ],
    );
    await client.query(
      `insert into audit_event (user_id, actor, event, proposal_id, data)
       values (tidysum_session_user(), $1, 'proposal.created', $2, $3)`,
      [
        source,
        id,
        {
          state: "proposed",
          policy_version: loaded.versionId,
          scheduled: true,
          ...input,
          follow_up_of: followUpOf,
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
  return {
    id,
    state: "proposed",
    not_before: input.not_before ?? null,
    due_by: input.due_by ?? null,
    next: NEXT,
  };
}

// Watching the days ---------------------------------------------------------------------------

/** Tells the owner something, outside Tidysum's page. */
export type Notify = (title: string, body: string) => Promise<void>;

/**
 * A macOS notification. The text goes in as arguments, never into the script, so a title with
 * quotes in it can't change what runs.
 */
export const macNotify: Notify = (title, body) =>
  new Promise((resolve) => {
    execFile(
      "osascript",
      [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        title,
        body,
      ],
      { timeout: 10_000 },
      (err) => {
        if (err) console.error("notification failed:", err.message);
        resolve();
      },
    );
  });

export const logNotify: Notify = async (title, body) => {
  console.log(`${title}: ${body}`);
};

/** Starts the owner's agent on one action; resolves when it has been started (not finished). */
export type Dispatch = (action: Action) => Promise<void>;

/**
 * Runs the owner's own agent command (TIDYSUM_AGENT_COMMAND) for one approved, due action, with
 * its id in TIDYSUM_ACTION_ID and the request in TIDYSUM_ACTION_PROMPT. The command is the owner's
 * own configuration, run by their shell; Tidysum passes it nothing else.
 */
export function commandDispatch(command: string, timeoutMinutes = 30): Dispatch {
  return async (action) => {
    const child = execFile(
      "/bin/sh",
      ["-c", command],
      {
        timeout: timeoutMinutes * 60_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          TIDYSUM_ACTION_ID: action.id,
          TIDYSUM_ACTION_PROMPT: agentPrompt(action),
        },
      },
      (err, stdout, stderr) => {
        const tail = (s: string) => s.trim().split("\n").slice(-5).join("\n");
        if (err)
          console.error(`agent run for ${action.id} failed: ${err.message}\n${tail(stderr)}`);
        else console.log(`agent run for ${action.id} ended:\n${tail(stdout)}`);
      },
    );
    child.stdin?.end();
  };
}

/** What the owner's agent is asked to do when Tidysum starts it. Matches the skill's trigger. */
export function agentPrompt(action: Pick<Action, "id">): string {
  return `Carry out my approved Tidysum action ${action.id}: it is due today. Use the tidysum-actions skill (or the carry_out_action prompt), start it with start_action, and report every step. If a step needs me, report it as your_turn and stop.`;
}

export interface ScheduleCheck {
  due: string[];
  due_soon: string[];
  overdue: string[];
  dispatched: string[];
  /** Due once markets were calm, waiting again since they turned jumpy (decision 0008). */
  waiting: string[];
}

export interface ScheduleOptions {
  notify?: Notify;
  dispatch?: Dispatch;
  /** The local hour now, 0-23: the agent is only started inside `hours`. */
  hour?: number;
  /** Local hours the owner's agent may be started in, [from, to). */
  hours?: [number, number];
  now?: Date;
}

/** How many times Tidysum starts the owner's agent on one action before leaving it to them. */
const MAX_DISPATCHES = 3;

const plusDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const short = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

/**
 * Watches the days of the owner's actions, once an hour: notes each that comes due, is due
 * tomorrow, or ran out of time while still not done, telling the owner once for each; and starts
 * the owner's agent (when they set one up) on an approved, due action no agent has started yet.
 */
export async function checkSchedule(
  db: Db,
  agentDb: AgentDb,
  userId: string,
  today: string,
  opts: ScheduleOptions = {},
): Promise<ScheduleCheck> {
  const result: ScheduleCheck = {
    due: [],
    due_soon: [],
    overdue: [],
    dispatched: [],
    waiting: [],
  };
  const now = opts.now ?? new Date();
  const { queue, in_progress, scheduled } = await listActions(agentDb, today);
  const open = [...queue, ...in_progress].filter(
    (a) => a.timing === "due" || a.timing === "overdue",
  );
  // Waiting for calm markets again after being told they were calm.
  const held = [...queue, ...scheduled].filter((a) => a.wait_for && a.timing === "waiting");
  if (!open.length && !held.length) return result;
  const ids = [...open, ...held].map((a) => a.id);
  const seen = await db
    .select({
      id: auditEvent.id,
      at: auditEvent.at,
      proposalId: auditEvent.proposalId,
      event: auditEvent.event,
      data: auditEvent.data,
    })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.userId, userId),
        inArray(auditEvent.proposalId, ids),
        inArray(auditEvent.event, [
          "proposal.due",
          "proposal.due_soon",
          "proposal.overdue",
          "proposal.dispatched",
          "proposal.waiting",
        ]),
      ),
    );
  const has = (id: string, event: string) =>
    seen.some((e) => e.proposalId === id && e.event === event);
  /** The newest such event's id, 0 for none. */
  const last = (id: string, event: string) =>
    Math.max(0, ...seen.filter((e) => e.proposalId === id && e.event === event).map((e) => e.id));
  /** When the owner's agent last paused it (decision 0006): it comes due afresh after that. */
  const pausedAt = (a: Action) =>
    a.progress?.paused ? Date.parse(a.progress.paused.at) : Number.NEGATIVE_INFINITY;
  const since = (a: Action) =>
    seen.filter((e) => e.proposalId === a.id && e.at.getTime() > pausedAt(a));
  // An action waiting for calm markets is due afresh each time they settle again, and a paused
  // one each time its day comes.
  const dueNoted = (a: Action) =>
    last(a.id, "proposal.due") > last(a.id, "proposal.waiting") &&
    since(a).some((e) => e.event === "proposal.due");
  const note = (id: string, event: string, data: object) =>
    db.insert(auditEvent).values({
      userId,
      at: now,
      actor: "tidysum",
      event: `proposal.${event}`,
      proposalId: id,
      data,
    });

  for (const a of held) {
    if (!dueNoted(a)) continue;
    await note(a.id, "waiting", { wait_for: a.wait_for, market: a.market });
    result.waiting.push(a.id);
    await opts.notify?.(
      "Tidysum: markets turned jumpy",
      `${a.title} waits again${a.market?.vix ? `: the VIX is ${Number(a.market.vix).toFixed(1)}` : ""}. Don't start it until Tidysum says markets are calm.`,
    );
  }

  for (const a of open) {
    const finished = a.progress?.status === "finished";
    if (finished) continue;
    // A paused action is named by what happens next ("Check for a card invite").
    const name = a.progress?.status === "paused" && a.next_step ? a.next_step : a.title;
    const approved = a.state === "approved";
    const agentCan = approved && a.carried_by === "agent";
    const days = { not_before: a.not_before, due_by: a.due_by };
    if (a.timing === "overdue") {
      if (!has(a.id, "proposal.overdue")) {
        await note(a.id, "overdue", days);
        result.overdue.push(a.id);
        await opts.notify?.(
          "Tidysum: past due",
          `${name} was due ${short(a.due_by ?? today)} and isn't done.`,
        );
      }
      continue;
    }
    // Due: say so once, on the first day.
    // Not started, or paused and its day has come (it's due, so the pause is over).
    const dispatching =
      agentCan &&
      !!opts.dispatch &&
      (!a.progress || a.progress.status === "paused") &&
      inHours(opts.hour, opts.hours) &&
      since(a).filter((e) => e.event === "proposal.dispatched").length < MAX_DISPATCHES &&
      !seen.some(
        (e) =>
          e.proposalId === a.id &&
          e.event === "proposal.dispatched" &&
          (e.data as { day?: string } | null)?.day === today,
      );
    if (!dueNoted(a)) {
      await note(
        a.id,
        "due",
        a.wait_for ? { ...days, wait_for: a.wait_for, market: a.market } : days,
      );
      result.due.push(a.id);
      const what = !approved
        ? "Approve it on the Actions page."
        : dispatching
          ? "Your agent is starting on it."
          : agentCan
            ? "It's ready for your agent."
            : "It's ready for you.";
      await opts.notify?.(
        a.wait_for === "calm_markets" ? "Tidysum: markets are calm" : "Tidysum: due now",
        a.wait_for === "calm_markets" && a.market?.vix
          ? `${name}. The VIX is ${a.market.vix}. ${what}`
          : `${name}. ${what}`,
      );
    } else if (
      a.due_by &&
      a.due_by <= plusDays(today, 1) &&
      a.not_before !== a.due_by &&
      !has(a.id, "proposal.due_soon")
    ) {
      await note(a.id, "due_soon", days);
      result.due_soon.push(a.id);
      await opts.notify?.(
        "Tidysum: last day soon",
        `${name} is due ${a.due_by === today ? "today" : "tomorrow"} and isn't done yet.`,
      );
    }
    if (dispatching && opts.dispatch) {
      await note(a.id, "dispatched", { day: today });
      result.dispatched.push(a.id);
      await opts.dispatch(a);
    }
  }
  return result;
}

function inHours(hour: number | undefined, hours: [number, number] | undefined): boolean {
  if (hour === undefined || !hours) return true;
  return hour >= hours[0] && hour < hours[1];
}

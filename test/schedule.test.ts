import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  carriedBy,
  decideAction,
  draftActions,
  isoToday,
  listActions,
  settleFinished,
  timingOf,
  windowOf,
} from "../src/actions/actions.js";
import { endAction, pauseAction, reportStep, startAction } from "../src/actions/agentRun.js";
import {
  agentPrompt,
  checkSchedule,
  type Dispatch,
  type Notify,
  parseSchedule,
  ScheduleRefused,
  scheduleAction,
} from "../src/actions/schedule.js";
import { agentCommand, agentHours, notifyMode } from "../src/config.js";
import { connect } from "../src/db/client.js";
import { appUser, auditEvent, misallocation, proposal } from "../src/db/schema.js";
import { connectAgent, connectProposer } from "../src/mcp/agentDb.js";
import { createTidysumMcpServer } from "../src/mcp/server.js";
import { type LoadedPolicy, parsePolicy } from "../src/policy/policy.js";
import { approveProposal } from "../src/policy/proposals.js";
import { activatePolicy } from "../src/policy/store.js";

const owner = connect(inject("databaseUrl"));
const plusDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// A user of its own: audit events can't be deleted, and other files count the owner's.
const [user] = await owner.db
  .insert(appUser)
  .values({ displayName: "Schedule test", investingEnabled: true })
  .returning({ id: appUser.id });
if (!user) throw new Error("no user");
const userId = user.id;
const agentDb = connectAgent(inject("databaseUrl"), userId);
const proposer = connectProposer(inject("databaseUrl"), userId);
const policy = parsePolicy({ version: 1, cash: { buffer: { amount: "500" }, tolerance: "100" } });
let loaded: LoadedPolicy = policy;
const clients: Client[] = [];
const PLAN = "11111111-1111-4111-8111-111111111111";

const check = {
  title: "Check that the new 401(k) percent reached the paycheck",
  rationale: "Raised to 28% before the Nov 19 cutoff; the Nov 30 paystub shows whether it took.",
  category: "securities",
  steps: [
    {
      text: "Open the Nov 30 paystub and check the pre-tax deduction is 28% of base pay",
      by: "agent",
      needs_you: "Sign-in",
    },
    {
      text: "If it isn't, set pre-tax to the whole percent that reaches the limit in December",
      by: "agent",
      needs_you: "Sign-in",
    },
  ],
  not_before: "2026-11-27",
  due_by: "2026-12-03",
  finding_key: `retirement_rate:${PLAN}:2026:check`,
};

async function agent(name: string, today: string) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createTidysumMcpServer(agentDb, {
    proposer,
    loadPolicy: async () => loaded,
    today: () => today,
  }).connect(serverSide);
  const client = new Client({ name, version: "0" });
  await client.connect(clientSide);
  clients.push(client);
  return async (tool: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name: tool, arguments: args });
    const [first] = res.content as { type: string; text: string }[];
    if (res.isError) throw new Error(first?.text);
    return JSON.parse(first?.text ?? "null");
  };
}

async function eventsOf(id: string) {
  const rows = await owner.db
    .select({ event: auditEvent.event })
    .from(auditEvent)
    .where(eq(auditEvent.proposalId, id))
    .orderBy(auditEvent.id);
  return rows.map((r) => r.event);
}

beforeAll(async () => {
  await activatePolicy(owner.db, userId, policy);
  loaded = policy;
});

afterAll(async () => {
  for (const c of clients) await c.close();
  await agentDb.end();
  await proposer.end();
  await owner.close();
});

describe("an action's days", () => {
  it("reads as scheduled before its first day, due until its last, overdue after", () => {
    const a = { not_before: "2026-11-27", due_by: "2026-12-03" };
    expect(timingOf(a, "2026-11-20")).toBe("scheduled");
    expect(timingOf(a, "2026-11-27")).toBe("due");
    expect(timingOf(a, "2026-12-03")).toBe("due");
    expect(timingOf(a, "2026-12-04")).toBe("overdue");
    expect(timingOf({ not_before: null, due_by: "2027-04-15" }, "2026-12-01")).toBe("due");
    expect(timingOf({ not_before: null, due_by: null }, "2026-12-01")).toBeNull();
  });

  it("takes a detector's window, and ignores one that isn't dates", () => {
    expect(
      windowOf({ inputs: { window: { not_before: "2027-01-01", due_by: "2027-01-05" } } }),
    ).toEqual({ notBefore: "2027-01-01", dueBy: "2027-01-05", waitFor: null });
    expect(windowOf({ inputs: { window: { not_before: "soon", due_by: 5 } } })).toEqual({
      notBefore: null,
      dueBy: null,
      waitFor: null,
    });
    // A sale that waits for calm markets (decision 0008); anything else isn't a condition.
    expect(windowOf({ inputs: { wait_for: "calm_markets" } })).toEqual({
      notBefore: null,
      dueBy: null,
      waitFor: "calm_markets",
    });
    expect(windowOf({ inputs: { wait_for: "a dip" } }).waitFor).toBeNull();
  });

  it("refuses a schedule with no day, days out of order, or a secret in a step", () => {
    expect(() => parseSchedule({ ...check, not_before: undefined, due_by: undefined })).toThrow(
      /not_before, due_by or wait_for/,
    );
    expect(() => parseSchedule({ ...check, due_by: "2026-11-20" })).toThrow(/can't be before/);
    expect(() => parseSchedule({ ...check, steps: [{ text: "Run rm -rf", by: "robot" }] })).toThrow(
      ScheduleRefused,
    );
  });

  it("goes to the owner's agent when its key names a plan election, even with no finding yet", () => {
    const steps = [{ text: "Set it", by: "agent" as const }];
    expect(
      carriedBy({ category: "securities", actions: [], steps, finding_key: check.finding_key }),
    ).toBe("agent");
    expect(
      carriedBy({ category: "securities", actions: [], steps, finding_key: "new_money" }),
    ).toBe("agent");
  });

  it("reads its settings from the environment", () => {
    expect(notifyMode({}, "darwin")).toBe("macos");
    expect(notifyMode({}, "linux")).toBe("log");
    expect(notifyMode({ TIDYSUM_NOTIFY: "off" }, "darwin")).toBe("off");
    expect(agentCommand({ TIDYSUM_AGENT_COMMAND: "  " })).toBeUndefined();
    expect(agentHours({})).toEqual([8, 21]);
    expect(agentHours({ TIDYSUM_AGENT_HOURS: "7-23" })).toEqual([7, 23]);
    expect(agentHours({ TIDYSUM_AGENT_HOURS: "23-7" })).toEqual([8, 21]);
  });
});

describe("a scheduled action", () => {
  it("can be approved early, waits under scheduled, and can't start before its day", async () => {
    const r = await scheduleAction(owner.db, userId, parseSchedule(check), "owner", "2026-11-14");
    expect(r).toMatchObject({ state: "proposed", not_before: "2026-11-27", due_by: "2026-12-03" });

    const before = await listActions(agentDb, "2026-11-14");
    const waiting = before.queue.find((a) => a.id === r.id);
    expect(waiting).toMatchObject({ timing: "scheduled", carried_by: "agent" });

    const ok = await approveProposal(owner.db, agentDb, userId, r.id, "2026-11-14", "admin");
    expect(ok.approved).toBe(true);
    const approved = await listActions(agentDb, "2026-11-14");
    expect(approved.scheduled.map((a) => a.id)).toContain(r.id);
    expect(approved.in_progress.map((a) => a.id)).not.toContain(r.id);
    await expect(startAction(agentDb, proposer, r.id, "mcp:test")).rejects.toThrow(
      /can't be carried out before 2026-11-27/,
    );

    const due = await listActions(agentDb, "2026-11-27");
    expect(due.in_progress.find((a) => a.id === r.id)).toMatchObject({ timing: "due" });
    expect(due.scheduled.map((a) => a.id)).not.toContain(r.id);
  });

  it("is noted and told once when due, hands an approved one to the agent, and flags it late", async () => {
    const r = await scheduleAction(
      owner.db,
      userId,
      parseSchedule({ ...check, title: "Second check", not_before: "2026-11-28" }),
      "owner",
      "2026-11-14",
    );
    await approveProposal(owner.db, agentDb, userId, r.id, "2026-11-14", "admin");
    const told: string[] = [];
    const notify: Notify = async (title, body) => void told.push(`${title}: ${body}`);
    const started: string[] = [];
    const dispatch: Dispatch = async (a) => void started.push(a.id);

    // Too early in the day: told, but the agent waits for waking hours.
    const early = await checkSchedule(owner.db, agentDb, userId, "2026-11-28", {
      notify,
      dispatch,
      hour: 6,
      hours: [8, 21],
    });
    expect(early.due).toContain(r.id);
    expect(early.dispatched).not.toContain(r.id);
    expect(told.some((t) => t.includes("Second check") && t.includes("ready for your agent"))).toBe(
      true,
    );

    const later = await checkSchedule(owner.db, agentDb, userId, "2026-11-28", {
      notify,
      dispatch,
      hour: 9,
      hours: [8, 21],
    });
    expect(later.due).not.toContain(r.id);
    expect(later.dispatched).toContain(r.id);
    expect(started).toContain(r.id);
    // Once a day at most.
    const again = await checkSchedule(owner.db, agentDb, userId, "2026-11-28", {
      notify,
      dispatch,
      hour: 10,
      hours: [8, 21],
    });
    expect(again.dispatched).not.toContain(r.id);

    // The day before its last day it's still not done: a reminder.
    const soon = await checkSchedule(owner.db, agentDb, userId, "2026-12-02", { notify });
    expect(soon.due_soon).toContain(r.id);
    const late = await checkSchedule(owner.db, agentDb, userId, "2026-12-04", { notify });
    expect(late.overdue).toContain(r.id);
    const quiet = await checkSchedule(owner.db, agentDb, userId, "2026-12-05", { notify });
    expect(quiet.overdue).not.toContain(r.id);
    expect(await eventsOf(r.id)).toEqual([
      "proposal.created",
      "proposal.approved",
      "proposal.due",
      "proposal.dispatched",
      "proposal.due_soon",
      "proposal.overdue",
    ]);
    expect(agentPrompt({ id: r.id })).toContain(r.id);
  });

  it("comes due again when an agent's pause ends, and goes back to the agent", async () => {
    const today = isoToday();
    const r = await scheduleAction(
      owner.db,
      userId,
      parseSchedule({
        ...check,
        title: "Get the Gold Card",
        category: "card",
        not_before: today,
        due_by: undefined,
        finding_key: undefined,
      }),
      "owner",
      today,
    );
    await approveProposal(owner.db, agentDb, userId, r.id, today, "admin");
    const told: string[] = [];
    const started: string[] = [];
    const opts = {
      notify: (async (_t, b) => void told.push(b)) satisfies Notify,
      dispatch: (async (a) => void started.push(a.id)) satisfies Dispatch,
    };
    expect((await checkSchedule(owner.db, agentDb, userId, today, opts)).dispatched).toContain(
      r.id,
    );
    await startAction(agentDb, proposer, r.id, "mcp:claude-code");
    const until = plusDays(today, 14);
    await pauseAction(
      agentDb,
      proposer,
      { id: r.id, step: 1, until, next: "Check for a Gold Card invite" },
      "mcp:claude-code",
    );
    // Waiting: nothing to say or start.
    const quiet = await checkSchedule(owner.db, agentDb, userId, plusDays(today, 3), opts);
    expect(quiet.due).not.toContain(r.id);
    expect(quiet.dispatched).not.toContain(r.id);
    // Its day: due afresh, named by what happens next, and the agent is started again.
    const back = await checkSchedule(owner.db, agentDb, userId, until, opts);
    expect(back.due).toContain(r.id);
    expect(back.dispatched).toContain(r.id);
    expect(told.at(-1)).toContain("Check for a Gold Card invite");
    expect(started.filter((id) => id === r.id)).toHaveLength(2);
    await decideAction(owner.db, userId, r.id, "dismiss", "admin", until);
  });

  it("isn't handed to an agent until approved, and never once an agent has started it", async () => {
    const r = await scheduleAction(
      owner.db,
      userId,
      parseSchedule({ ...check, title: "Not approved yet", not_before: "2026-11-29" }),
      "owner",
      "2026-11-14",
    );
    const told: string[] = [];
    const started: string[] = [];
    const out = await checkSchedule(owner.db, agentDb, userId, "2026-11-29", {
      notify: async (_t, b) => void told.push(b),
      dispatch: async (a) => void started.push(a.id),
    });
    expect(out.due).toContain(r.id);
    expect(started).not.toContain(r.id);
    expect(told.some((b) => b.includes("Not approved yet") && b.includes("Approve it"))).toBe(true);
    await decideAction(owner.db, userId, r.id, "dismiss", "admin", "2026-11-29");
  });

  it("refuses a past last day, and investing actions for a user without investing", async () => {
    await expect(
      scheduleAction(
        owner.db,
        userId,
        parseSchedule({ ...check, not_before: undefined, due_by: "2026-11-01" }),
        "owner",
        "2026-11-14",
      ),
    ).rejects.toThrow(/already passed/);
    const [other] = await owner.db
      .insert(appUser)
      .values({ displayName: "No investing" })
      .returning({ id: appUser.id });
    if (!other) throw new Error("no user");
    await expect(
      scheduleAction(owner.db, other.id, parseSchedule(check), "owner", "2026-11-14"),
    ).rejects.toThrow(/investing turned on/);
  });

  it("can be suggested by the owner's agent over MCP, which still can't approve it", async () => {
    const call = await agent("claude-code", "2026-11-14");
    const r = await call("schedule_action", {
      ...check,
      title: "Agent's check",
      finding_key: `retirement_rate:${PLAN}:2026:agent-check`,
    });
    expect(r).toMatchObject({ state: "proposed", not_before: "2026-11-27" });
    const [row] = await owner.db
      .select({ source: proposal.source, steps: proposal.steps, notBefore: proposal.notBefore })
      .from(proposal)
      .where(eq(proposal.id, r.id));
    expect(row).toMatchObject({ source: "mcp:claude-code", notBefore: "2026-11-27" });
    expect(row?.steps).toHaveLength(2);
    const listed = await call("list_actions");
    expect(listed.queue.find((a: { id: string }) => a.id === r.id)).toMatchObject({
      timing: "scheduled",
    });
    // The proposer role can't move it to approved.
    await expect(
      proposer.query("update proposal set state = 'approved' where id = $1", [r.id]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("a detector's action with a window", () => {
  it("drafts next year's 401(k) percent to wait for its window", async () => {
    const key = `retirement_rate:${PLAN}:2027:lower`;
    await owner.db.insert(misallocation).values({
      userId,
      key,
      category: "securities",
      detector: "retirement_rate",
      summary: "At 28% of pay, your Acme 401(k) contributions reach the 2027 limit early.",
      annualCost: "929.00",
      accountIds: [],
      action: "Set your Acme 401(k) contributions to 13% before your first 2027 paycheck",
      inputs: {
        plan_name: "Acme 401(k)",
        kind: "lower",
        year: 2027,
        this_year: false,
        current_percent: "28",
        new_percent: "13",
        window: { not_before: "2027-01-01", due_by: "2027-01-05" },
      },
      state: "open",
      firstSeenAt: new Date("2026-12-01T00:00:00Z"),
      lastSeenAt: new Date("2026-12-01T00:00:00Z"),
    });
    await draftActions(owner.db, userId, new Date("2026-12-01T00:00:00Z"));
    const [drafted] = await owner.db
      .select({ notBefore: proposal.notBefore, dueBy: proposal.dueBy })
      .from(proposal)
      .where(and(eq(proposal.userId, userId), eq(proposal.findingKey, key)));
    expect(drafted).toEqual({ notBefore: "2027-01-01", dueBy: "2027-01-05" });
  });
});

describe("a follow-up check", () => {
  it("confirms the change it checks once the agent finishes it, and shows done at once", async () => {
    const key = `retirement_rate:${PLAN}:2026:raise`;
    const [change] = await owner.db
      .insert(proposal)
      .values({
        id: crypto.randomUUID(),
        userId,
        policyVersionId: loaded.versionId,
        source: "tidysum",
        title: "Raise the 401(k)",
        rationale: "Short of the limit.",
        state: "approved",
        category: "securities",
        findingKey: key,
        validation: { violations: [], warnings: [], numbers: {} },
        steps: [{ text: "Set pre-tax to 28%", by: "agent" }],
      })
      .returning({ id: proposal.id });
    if (!change) throw new Error("no proposal");
    const today = new Date().toISOString().slice(0, 10);
    const r = await scheduleAction(
      owner.db,
      userId,
      parseSchedule({
        ...check,
        title: "Paystub check",
        not_before: undefined,
        due_by: "2099-12-31",
        follows_up: key,
      }),
      "owner",
      today,
    );
    await approveProposal(owner.db, agentDb, userId, r.id, today, "admin");
    const listed = await listActions(agentDb, today);
    expect(listed.in_progress.find((a) => a.id === r.id)).toMatchObject({
      follow_up_of: change.id,
    });

    await startAction(agentDb, proposer, r.id, "mcp:test");
    for (const step of [1, 2]) {
      await reportStep(agentDb, proposer, { id: r.id, step, status: "done" }, "mcp:test");
    }
    await endAction(
      agentDb,
      proposer,
      { id: r.id, outcome: "finished", note: "Paystub shows 28% pre-tax" },
      "mcp:test",
    );
    await settleFinished(owner.db, userId);
    await settleFinished(owner.db, userId);
    const states = await owner.db
      .select({ id: proposal.id, state: proposal.state })
      .from(proposal)
      .where(eq(proposal.userId, userId));
    expect(states.find((p) => p.id === r.id)?.state).toBe("done");
    expect(states.find((p) => p.id === change.id)?.state).toBe("confirmed");
    // Settled twice, recorded once.
    expect((await eventsOf(r.id)).filter((e) => e === "proposal.done")).toHaveLength(1);
    expect(await eventsOf(change.id)).toContain("proposal.confirmed");
  });

  it("refuses to follow up an action that doesn't exist", async () => {
    await expect(
      scheduleAction(
        owner.db,
        userId,
        parseSchedule({ ...check, follows_up: "retirement_rate:nothing" }),
        "owner",
        "2026-11-14",
      ),
    ).rejects.toThrow(/to follow up/);
  });
});

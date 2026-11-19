import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  carriedBy,
  decideAction,
  draftActions,
  getAction,
  listActions,
} from "../src/actions/actions.js";
import { AGENT_RULES, checkNote, sitesFor } from "../src/actions/agentRun.js";
import { type ProgressEvent, progressFrom } from "../src/actions/progress.js";
import { connect } from "../src/db/client.js";
import {
  type ActionStep,
  appUser,
  auditEvent,
  misallocation,
  policyVersion,
  proposal,
} from "../src/db/schema.js";
import { connectAgent, connectProposer } from "../src/mcp/agentDb.js";
import { createTidysumMcpServer } from "../src/mcp/server.js";
import { parsePolicy } from "../src/policy/policy.js";
import { activatePolicy } from "../src/policy/store.js";

const TODAY = "2026-11-12";
const owner = connect(inject("databaseUrl"));
// A user of its own: audit events can't be deleted, and other files count the owner's.
const [agentUser] = await owner.db
  .insert(appUser)
  .values({ displayName: "Agent run test" })
  .returning({ id: appUser.id });
if (!agentUser) throw new Error("no user");
const userId = agentUser.id;
const agentDb = connectAgent(inject("databaseUrl"), userId);
const proposer = connectProposer(inject("databaseUrl"), userId);
const policy = parsePolicy({ version: 1, cash: { buffer: { amount: "500" }, tolerance: "100" } });
let policyId = "";
const clients: Client[] = [];

/** An MCP client whose name becomes the agent's name in Tidysum's record. */
async function agent(name: string) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createTidysumMcpServer(agentDb, {
    proposer,
    loadPolicy: async () => policy,
    today: () => TODAY,
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

const STEPS: ActionStep[] = [
  { text: "Open a Better Bank HY Savings", by: "agent", needs_you: "Identity check and signature" },
  { text: "Link the new account in Connections", by: "you" },
  { text: "Move about $9,000 from Checking into it", by: "agent", needs_you: "Two-factor code" },
];

async function action(over: Partial<typeof proposal.$inferInsert> = {}) {
  const [row] = await owner.db
    .insert(proposal)
    .values({
      id: crypto.randomUUID(),
      userId,
      policyVersionId: policyId,
      source: "tidysum",
      title: "Move idle cash to Better Bank",
      rationale: "Checking pays nothing.",
      state: "approved",
      category: "cash",
      expectedAnnualValue: "360.00",
      validation: { violations: [], warnings: [], numbers: {} },
      steps: STEPS,
      ...over,
    })
    .returning({ id: proposal.id });
  if (!row) throw new Error("no proposal");
  return row.id;
}

async function events(id: string) {
  const rows = await owner.db
    .select({ event: auditEvent.event, actor: auditEvent.actor })
    .from(auditEvent)
    .where(eq(auditEvent.proposalId, id))
    .orderBy(auditEvent.id);
  return rows.map((r) => `${r.actor} ${r.event}`);
}

beforeAll(async () => {
  await activatePolicy(owner.db, userId, policy);
  const [row] = await owner.db
    .select({ id: policyVersion.id })
    .from(policyVersion)
    .where(eq(policyVersion.userId, userId));
  policyId = row?.id ?? "";
});

afterAll(async () => {
  for (const c of clients) await c.close();
  await agentDb.end();
  await proposer.end();
  await owner.close();
});

describe("an agent carrying out an approved action", () => {
  it("starts it, reports steps, hands over to the owner, and finishes", async () => {
    const id = await action({ findingKey: "deposit_rate:test" });
    await owner.db.insert(misallocation).values({
      userId,
      key: "deposit_rate:test",
      detector: "deposit_rate",
      category: "cash",
      summary: "Checking pays nothing",
      action: "Move it",
      annualCost: "360.00",
      accountIds: [],
      inputs: {
        alternative: { provider: "Better Bank", source_url: "https://www.better.example/hy" },
      },
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });
    const call = await agent("claude-code");

    const started = await call("start_action", { id });
    expect(started.steps.map((s: { step: number; by: string }) => [s.step, s.by])).toEqual([
      [1, "agent"],
      [2, "you"],
      [3, "agent"],
    ]);
    expect(started.sites).toEqual(["better.example"]);
    expect(started.rules).toEqual([...AGENT_RULES]);
    expect(started.progress).toMatchObject({ agent: "mcp:claude-code", status: "working" });

    await call("report_step", {
      id,
      step: 1,
      status: "your_turn",
      note: "Finish the identity check Better Bank opened in the browser",
    });
    let [shown] = (await listActions(agentDb, TODAY)).in_progress;
    expect(shown?.progress).toMatchObject({
      status: "your_turn",
      your_turn: { step: 1, note: "Finish the identity check Better Bank opened in the browser" },
    });

    await call("report_step", { id, step: 1, status: "done" });
    await call("report_step", { id, step: 3, status: "done", note: "Moved $9,000" });
    [shown] = (await listActions(agentDb, TODAY)).in_progress;
    expect(shown?.progress).toMatchObject({ status: "working", done: [1, 3], your_turn: null });

    const finished = await call("finish_action", { id, note: "Opened and funded" });
    expect(finished.progress).toMatchObject({ status: "finished", note: "Opened and funded" });

    // The agent can't write the proposal; the owner side marks it done on its next pass.
    expect((await getAction(agentDb, id))?.state).toBe("approved");
    await draftActions(owner.db, userId);
    expect((await getAction(agentDb, id))?.state).toBe("done");
    expect(await events(id)).toEqual([
      "mcp:claude-code action.started",
      "mcp:claude-code action.your_turn",
      "mcp:claude-code action.step_done",
      "mcp:claude-code action.step_done",
      "mcp:claude-code action.finished",
      "mcp:claude-code proposal.done",
    ]);
  });

  it("refuses an action the owner hasn't approved, and investing with no steps for it", async () => {
    const call = await agent("claude-code");
    const waiting = await action({ state: "proposed" });
    await expect(call("start_action", { id: waiting })).rejects.toThrow(/hasn't approved/);
    const trade = await action({
      category: "securities",
      steps: [{ text: "Buy $500 of VTI", by: "you" }],
    });
    await expect(call("start_action", { id: trade })).rejects.toThrow(/no steps for an agent/);
    const done = await action({ state: "done" });
    await expect(call("start_action", { id: done })).rejects.toThrow(/nothing left/);
    expect(await events(waiting)).toEqual([]);
    expect(await events(trade)).toEqual([]);
  });

  it("lets the agent prepare a trade for the owner to submit", async () => {
    const call = await agent("claude-code");
    const id = await action({
      category: "securities",
      title: "Invest new money toward your target mix",
      steps: [
        { text: "Buy $500 of VTI", by: "agent", needs_you: "Review the order and press Submit" },
      ],
    });
    const started = (await call("start_action", { id })) as { rules: string[] };
    expect(started.rules.join(" ")).toMatch(/presses Submit themselves.*Never press the button/);
    await call("report_step", {
      id,
      step: 1,
      status: "your_turn",
      note: "The VTI order is on the review screen: press Submit.",
    });
    expect(await events(id)).toEqual([
      "mcp:claude-code action.started",
      "mcp:claude-code action.your_turn",
    ]);
  });

  it("lets the agent carry out a 401(k) election, which places no trade", async () => {
    expect(
      carriedBy({
        category: "securities",
        actions: [],
        steps: STEPS,
        finding: { detector: "retirement_rate" },
      }),
    ).toBe("agent");
    expect(
      carriedBy({
        category: "securities",
        actions: [],
        steps: STEPS,
        finding: { detector: "fund_fee" },
      }),
    ).toBe("agent");
    expect(carriedBy({ category: "securities", actions: [], steps: STEPS, finding: null })).toBe(
      "agent",
    );
    expect(
      carriedBy({
        category: "securities",
        actions: [],
        steps: [{ text: "Buy $500 of VTI", by: "you" }],
        finding: null,
      }),
    ).toBe("tidysum");
  });

  it("needs a start, the right agent, real steps, and every agent step before finishing", async () => {
    const id = await action();
    const claude = await agent("claude-code");
    await expect(claude("report_step", { id, step: 1, status: "done" })).rejects.toThrow(
      /start_action first/,
    );
    await claude("start_action", { id });
    await expect(claude("report_step", { id, step: 4, status: "done" })).rejects.toThrow(
      /steps 1 to 3/,
    );
    await expect(claude("report_step", { id, step: 1, status: "your_turn" })).rejects.toThrow(
      /what the owner needs/,
    );
    await claude("report_step", { id, step: 1, status: "done" });
    await expect(claude("finish_action", { id })).rejects.toThrow(/Steps 3 aren't reported/);

    const other = await agent("chatgpt");
    await expect(other("report_step", { id, step: 3, status: "done" })).rejects.toThrow(
      /Another agent \(claude-code\)/,
    );
    // Taking over starts afresh.
    const taken = await other("start_action", { id });
    expect(taken.progress).toMatchObject({ agent: "mcp:chatgpt", done: [] });
    await expect(claude("report_step", { id, step: 3, status: "done" })).rejects.toThrow(
      /Another agent \(chatgpt\)/,
    );
  });

  it("stops with a reason, which the owner sees, and keeps the approval", async () => {
    const id = await action();
    const call = await agent("claude-code");
    await call("start_action", { id });
    await expect(call("stop_action", { id, note: " " })).rejects.toThrow(/why you stopped/);
    await call("stop_action", { id, note: "The rate on the site is 3.1%, not 4%" });
    const shown = (await listActions(agentDb, TODAY)).in_progress.find((a) => a.id === id);
    expect(shown?.progress).toMatchObject({
      status: "stopped",
      note: "The rate on the site is 3.1%, not 4%",
    });
    await expect(call("report_step", { id, step: 1, status: "done" })).rejects.toThrow(
      /start_action first/,
    );
    await draftActions(owner.db, userId);
    expect((await getAction(agentDb, id))?.state).toBe("approved");
  });

  it("can't report on an action the owner withdrew", async () => {
    const id = await action();
    const call = await agent("claude-code");
    await call("start_action", { id });
    expect(await decideAction(owner.db, userId, id, "dismiss", "owner", TODAY)).toBe(true);
    await expect(call("report_step", { id, step: 1, status: "done" })).rejects.toThrow(
      /dismissed, so there is nothing left/,
    );
  });

  it("keeps codes, SSNs and account numbers out of notes", async () => {
    const id = await action();
    const call = await agent("claude-code");
    await call("start_action", { id });
    for (const note of ["Code was 482913", "SSN 123-45-6789", "Account 0001 2345 6789"]) {
      await expect(call("report_step", { id, step: 1, status: "done", note })).rejects.toThrow(
        /can't contain codes/,
      );
    }
    expect(checkNote("Moved $9,000 on 12 Nov")).toBe("Moved $9,000 on 12 Nov");
    expect(checkNote("  ")).toBeNull();
  });
});

describe("progress", () => {
  const e = (event: ProgressEvent["event"], data: ProgressEvent["data"] = {}, actor = "mcp:a") => ({
    at: "2026-11-12T10:00:00Z",
    actor,
    event,
    data,
  });

  it("counts only what happened since the latest start", () => {
    expect(progressFrom(null)).toBeNull();
    expect(progressFrom([e("action.step_done", { step: 1 })])).toBeNull();
    expect(
      progressFrom([
        e("action.started"),
        e("action.step_done", { step: 1 }),
        e("action.stopped", { note: "blocked" }),
        e("action.started", {}, "mcp:b"),
        e("action.step_done", { step: 2 }, "mcp:b"),
      ]),
    ).toMatchObject({ agent: "mcp:b", status: "working", done: [2], note: null });
  });

  it("a later step done clears the owner's turn", () => {
    expect(
      progressFrom([
        e("action.started"),
        e("action.your_turn", { step: 1, note: "Enter the code" }),
        e("action.step_done", { step: 1 }),
      ]),
    ).toMatchObject({ status: "working", your_turn: null, done: [1] });
  });

  it("finds the sites on the finding it fixes", () => {
    const sites = sitesFor({
      finding: {
        inputs: { a: { source_url: "https://www.x.example/p" }, b: ["https://y.example"] },
      },
    } as never);
    expect(sites).toEqual(["x.example", "y.example"]);
  });
});

describe("the packaged skill", () => {
  it("carries every rule start_action returns", async () => {
    const skill = await readFile("skills/tidysum-actions/SKILL.md", "utf8");
    for (const rule of AGENT_RULES) expect(skill).toContain(rule);
    expect(skill).toMatch(/^---\nname: tidysum-actions\ndescription: /);
  });
});

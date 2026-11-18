// Where an owner's agent has got to on an approved action (decision 0005), derived from the
// audit events it writes through the MCP tools in agentRun.ts.

/** Audit events an agent writes while carrying out an action, oldest first. */
export const AGENT_EVENTS = [
  "action.started",
  "action.step_done",
  "action.your_turn",
  "action.stopped",
  "action.finished",
] as const;
export type AgentEvent = (typeof AGENT_EVENTS)[number];

export interface ProgressEvent {
  at: string;
  actor: string;
  event: AgentEvent;
  data: { step?: number; note?: string | null };
}

/** Where an agent has got to on an action, from its reports since it last started it. */
export interface ActionProgress {
  /** The agent carrying it out, e.g. "mcp:claude-code". */
  agent: string;
  started_at: string;
  status: "working" | "your_turn" | "stopped" | "finished";
  /** 1-based numbers of the steps reported done. */
  done: number[];
  /** What the agent needs from the owner, while status is your_turn. */
  your_turn: { step: number; note: string; at: string } | null;
  /** Why it stopped, or its closing note when finished. */
  note: string | null;
  updated_at: string;
}

/** Progress from an action's agent events: everything after its latest start. */
export function progressFrom(events: ProgressEvent[] | null | undefined): ActionProgress | null {
  if (!events?.length) return null;
  let start = -1;
  for (const [i, e] of events.entries()) if (e.event === "action.started") start = i;
  if (start < 0) return null;
  const first = events[start];
  if (!first) return null;
  const progress: ActionProgress = {
    agent: first.actor,
    started_at: first.at,
    status: "working",
    done: [],
    your_turn: null,
    note: null,
    updated_at: first.at,
  };
  for (const e of events.slice(start + 1)) {
    progress.updated_at = e.at;
    const step = e.data.step;
    switch (e.event) {
      case "action.step_done":
        if (step && !progress.done.includes(step)) progress.done.push(step);
        if (progress.your_turn && step && step >= progress.your_turn.step) {
          progress.your_turn = null;
        }
        progress.status = progress.your_turn ? "your_turn" : "working";
        break;
      case "action.your_turn":
        progress.your_turn = { step: step ?? 0, note: e.data.note ?? "", at: e.at };
        progress.status = "your_turn";
        break;
      case "action.stopped":
        progress.status = "stopped";
        progress.your_turn = null;
        progress.note = e.data.note ?? null;
        break;
      case "action.finished":
        progress.status = "finished";
        progress.your_turn = null;
        progress.note = e.data.note ?? null;
        break;
    }
  }
  progress.done.sort((a, b) => a - b);
  return progress;
}

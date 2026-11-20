// Where an owner's agent has got to on an approved action (decision 0005), derived from the
// audit events it writes through the MCP tools in agentRun.ts.

/** Audit events an agent writes while carrying out an action, oldest first. */
export const AGENT_EVENTS = [
  "action.started",
  "action.step_done",
  "action.your_turn",
  "action.stopped",
  "action.finished",
  "action.paused",
] as const;
export type AgentEvent = (typeof AGENT_EVENTS)[number];

export interface ProgressEvent {
  at: string;
  actor: string;
  event: AgentEvent;
  data: {
    step?: number;
    note?: string | null;
    /** For a pause: the day the agent picks it up again, and what it does then. */
    until?: string;
    next?: string;
  };
}

/**
 * A run paused part way (decision 0006): a step is started but can only go on later, like a card
 * waitlist that sends an invite some day, or a paycheck that has to land first. The action waits
 * under Scheduled until `until`, then the agent picks it up again at `next`, keeping its done
 * steps.
 */
export interface ActionPause {
  /** The step that waits. */
  step: number;
  /** The day the agent picks it up again. */
  until: string;
  /** What it does then, in a few words: the action's headline while it waits. Agent text. */
  next: string;
  at: string;
}

/** Where an agent has got to on an action, from its reports since it last started it. */
export interface ActionProgress {
  /** The agent carrying it out, e.g. "mcp:claude-code". */
  agent: string;
  started_at: string;
  status: "working" | "your_turn" | "stopped" | "finished" | "paused";
  /** 1-based numbers of the steps reported done. */
  done: number[];
  /** What the agent needs from the owner, while status is your_turn. */
  your_turn: { step: number; note: string; at: string } | null;
  /** Why it stopped, its closing note when finished, or where things stand when paused. */
  note: string | null;
  /** While status is paused: when it goes on, and with what. */
  paused: ActionPause | null;
  updated_at: string;
}

/**
 * Progress from an action's agent events: everything after its latest start. A start after a
 * pause resumes the paused run, so the steps done before the pause stay done.
 */
export function progressFrom(events: ProgressEvent[] | null | undefined): ActionProgress | null {
  if (!events?.length) return null;
  let progress: ActionProgress | null = null;
  for (const e of events) {
    if (e.event === "action.started") {
      const resumed: number[] = progress?.status === "paused" ? progress.done : [];
      progress = {
        agent: e.actor,
        started_at: e.at,
        status: "working",
        done: [...resumed],
        your_turn: null,
        note: null,
        paused: null,
        updated_at: e.at,
      };
      continue;
    }
    if (!progress) continue;
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
      case "action.paused":
        progress.status = "paused";
        progress.your_turn = null;
        progress.note = e.data.note ?? null;
        progress.paused = {
          step: step ?? 0,
          until: e.data.until ?? "",
          next: e.data.next ?? "",
          at: e.at,
        };
        break;
    }
  }
  progress?.done.sort((a, b) => a - b);
  return progress;
}

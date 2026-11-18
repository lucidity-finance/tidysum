import { readFile } from "node:fs/promises";
import type { Db } from "../db/client.js";
import { financialPlan } from "../db/schema.js";
import type { AgentDb } from "../mcp/agentDb.js";

// The owner's written plan for their money: what it is for, the target mix, where each dollar
// goes and the rules they keep. The owner writes it as Markdown (it can live in a repository) and
// `tidysum plan set` stores it. Agents read it to keep their advice inside it; the admin page
// shows it, parsed here into plain blocks so the page never renders HTML from text.

export const MAX_PLAN_LENGTH = 100_000;

export async function setPlan(db: Db, userId: string, markdown: string): Promise<void> {
  const text = markdown.replace(/\r\n?/g, "\n").trim();
  if (!text) throw new Error("the plan is empty");
  if (text.length > MAX_PLAN_LENGTH) {
    throw new Error(`the plan is longer than ${MAX_PLAN_LENGTH} characters`);
  }
  await db
    .insert(financialPlan)
    .values({ userId, markdown: text })
    .onConflictDoUpdate({
      target: financialPlan.userId,
      set: { markdown: text, updatedAt: new Date() },
    });
}

export async function setPlanFile(db: Db, userId: string, file: string): Promise<void> {
  await setPlan(db, userId, await readFile(file, "utf8"));
}

export type PlanReport =
  | { state: "none" }
  | { state: "ready"; markdown: string; updated_at: string };

/** The agent's own user's plan, through row-level security. */
export async function readPlan(db: AgentDb): Promise<PlanReport> {
  const { rows } = await db.query<{ markdown: string; updated_at: string }>(
    "select markdown, updated_at from financial_plan",
  );
  const row = rows[0];
  return row
    ? { state: "ready", markdown: row.markdown, updated_at: row.updated_at }
    : { state: "none" };
}

// Markdown, the subset a plan needs -------------------------------------------------------------

/** A run of text. `href` is only ever an http(s) URL. */
export interface Span {
  text: string;
  bold?: true;
  code?: true;
  href?: string;
}

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4; spans: Span[] }
  | { type: "paragraph"; spans: Span[] }
  | { type: "list"; ordered: boolean; start: number; items: Span[][] }
  | { type: "table"; header: Span[][]; rows: Span[][][] };

const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  const plain = (t: string) => {
    if (!t) return;
    const last = spans.at(-1);
    if (last && !last.bold && !last.code && !last.href) last.text += t;
    else spans.push({ text: t });
  };
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    plain(text.slice(at, m.index));
    const [whole, bold, code, label, href] = m;
    if (bold !== undefined) spans.push({ text: bold, bold: true });
    else if (code !== undefined) spans.push({ text: code, code: true });
    else if (label !== undefined && href !== undefined && /^https?:\/\//i.test(href)) {
      spans.push({ text: label, href });
    } else plain(whole);
    at = m.index + whole.length;
  }
  plain(text.slice(at));
  return spans;
}

const HEADING = /^(#{1,4})\s+(.*?)\s*#*\s*$/;
const ITEM = /^ {0,3}([-*+]|(\d{1,9})[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => parseInline(c.trim()));

export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;

  const flush = () => {
    if (para.length) blocks.push({ type: "paragraph", spans: parseInline(para.join(" ")) });
    para = [];
    if (list) {
      blocks.push({
        type: "list",
        ordered: list.ordered,
        start: list.start,
        items: list.items.map(parseInline),
      });
    }
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading?.[1] && heading[2] !== undefined) {
      flush();
      const level = heading[1].length as 1 | 2 | 3 | 4;
      blocks.push({ type: "heading", level, spans: parseInline(heading[2]) });
      continue;
    }
    if (line.trimStart().startsWith("|") && TABLE_RULE.test(lines[i + 1] ?? "")) {
      flush();
      const header = cells(line);
      const rows: Span[][][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").trimStart().startsWith("|")) {
        rows.push(cells(lines[i] ?? ""));
        i++;
      }
      i--;
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const item = ITEM.exec(line);
    if (item?.[1] && item[3] !== undefined) {
      const ordered = item[2] !== undefined;
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, start: ordered ? Number(item[2]) : 1, items: [] };
      }
      list.items.push(item[3]);
      continue;
    }
    if (list && /^\s/.test(line)) {
      // An indented line continues the last item.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (list) flush();
    para.push(line.trim());
  }
  flush();
  return blocks;
}

/** What the admin page shows: the plan as blocks, never as HTML. */
export function planForPage(r: PlanReport) {
  return r.state === "ready"
    ? { state: r.state, updated_at: r.updated_at, blocks: parseMarkdown(r.markdown) }
    : r;
}

import type { Block, Span } from "./plan.js";

// How the Plan page lays out a written plan, so it reads at a glance instead of as a wall of
// text. Nothing here is specific to one person's plan: each "##" section becomes a fold with a
// one-line preview, a list item shows its first sentence and keeps the rest one click away, a
// table whose column is all percentages becomes a mix bar, and a two-column table becomes
// label/value rows. Every word of the plan is still there; the page decides only what shows
// first.

/** One list item: an optional short tag ("Now", "By December 31"), its first sentence, the rest. */
export interface PlanItem {
  tag?: string;
  head: Span[];
  more: Span[];
}

export interface MixRow {
  label: string;
  /** The target share as written, without the sign: "60", "7.5". */
  percent: string;
  /** The color key the money-style bars use, or null for a bucket they don't name. */
  key: string | null;
  note: Span[];
}

export type Part =
  | { type: "items"; ordered: boolean; start: number; items: PlanItem[] }
  | { type: "mix"; label: string; rows: MixRow[] }
  | { type: "pairs"; header: [string, string]; rows: { key: Span[]; value: Span[] }[] }
  | { type: "table"; header: Span[][]; rows: Span[][][] }
  | { type: "note"; title?: string; head: Span[]; more: Span[] }
  | { type: "heading"; spans: Span[] };

export interface PlanSection {
  title: string;
  /** What the closed fold shows: a mix bar, the first sentence, or the row labels. */
  preview: { mix: MixRow[] } | { text: string };
  /** How many items or rows the section holds, when it is one list or table. */
  count: number | null;
  parts: Part[];
}

export interface PlanLayout {
  /** "Last reviewed: 2026-11-18" in the opening lines, as a date. */
  reviewed: string | null;
  intro: Part[];
  sections: PlanSection[];
}

const text = (spans: Span[]) => spans.map((s) => s.text).join("");

/** Spans with the leading or trailing whitespace of the whole run removed. */
function trim(spans: Span[]): Span[] {
  const out = spans.map((s) => ({ ...s })).filter((s) => s.text !== "");
  const first = out[0];
  if (first) first.text = first.text.replace(/^\s+/, "");
  const last = out.at(-1);
  if (last) last.text = last.text.replace(/\s+$/, "");
  return out.filter((s) => s.text !== "");
}

// Short words that end in a period without ending a sentence.
const ABBREVIATION =
  /(?:^|[\s(.])(?:e\.g|i\.e|etc|vs|approx|incl|St|Mr|Ms|Mrs|Dr|No|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|[A-Z])$/;

const SHORT_ENOUGH = 120;
const MIN_HEAD = 20;
const MIN_REST = 25;

/**
 * Splits a run after its first sentence. A stop inside parentheses, after an abbreviation such as
 * "U.S." or "e.g.", or inside code or a link doesn't end a sentence. Short runs stay whole.
 */
export function firstSentence(spans: Span[]): { head: Span[]; more: Span[] } {
  const all = trim(spans);
  if (text(all).length <= SHORT_ENOUGH) return { head: all, more: [] };
  let depth = 0;
  let seen = 0;
  for (let i = 0; i < all.length; i++) {
    const span = all[i] as Span;
    const plain = !span.code && !span.href;
    for (let j = 0; j < span.text.length; j++) {
      const c = span.text[j];
      if (!plain) continue;
      if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      else if ((c === "." || c === "!" || c === "?") && depth === 0) {
        const before = span.text.slice(0, j);
        const after =
          span.text.slice(j + 1) +
          all
            .slice(i + 1)
            .map((s) => s.text)
            .join("");
        if (!/^\s+["“(]?[A-Z0-9$]/.test(after)) continue;
        if (c === "." && ABBREVIATION.test(before)) continue;
        if (seen + j + 1 < MIN_HEAD || after.trim().length < MIN_REST) continue;
        const head = [...all.slice(0, i), { ...span, text: span.text.slice(0, j + 1) }];
        const more = [{ ...span, text: span.text.slice(j + 1) }, ...all.slice(i + 1)];
        return { head: trim(head), more: trim(more) };
      }
    }
    seen += span.text.length;
  }
  return { head: all, more: [] };
}

/** "**Now:** sell the fund" has a tag; "**Goal one.** More text" has a bold first sentence. */
export function planItem(spans: Span[]): PlanItem {
  const all = trim(spans);
  const lead = all[0];
  if (lead?.bold) {
    const t = lead.text.trim();
    if (t.endsWith(":") && t.length <= 40 && all.length > 1) {
      const rest = trim(all.slice(1));
      const first = rest[0];
      // "**Now:** sell" reads as "Sell" once "Now" is a tag of its own.
      if (first && !first.code && !first.href) {
        rest[0] = { ...first, text: first.text.charAt(0).toUpperCase() + first.text.slice(1) };
      }
      return { tag: t.slice(0, -1).trim(), ...firstSentence(rest) };
    }
    if (/[.!?]$/.test(t) && all.length > 1) return { head: [lead], more: trim(all.slice(1)) };
  }
  return firstSentence(all);
}

const PERCENT = /^\s*(\d{1,3}(?:\.\d+)?)\s*%\s*$/;

/** The color key the money-style mix bars use for a bucket named this way. */
export function mixKey(label: string): string | null {
  const l = label.toLowerCase();
  if (/international|intl|ex-?us|foreign|non-us|developed|emerging/.test(l)) return "intl_stocks";
  if (/gold/.test(l)) return "gold";
  if (/commodit|metal/.test(l)) return "commodities";
  if (/bond|treasur|fixed income/.test(l)) return "bonds_and_cash";
  if (/cash|money market|savings/.test(l)) return "cash";
  if (/\b(us|u\.s\.|domestic|american)\b|s&p|total (stock )?market/.test(l)) return "us_stocks";
  return null;
}

function tablePart(b: Extract<Block, { type: "table" }>): Part {
  const width = b.header.length;
  const rows = b.rows.filter((r) => r.some((c) => text(c).trim()));
  // A column of percentages that adds up to about 100 is a target mix.
  for (let col = 1; col < width && rows.length >= 2; col++) {
    const values = rows.map((r) => PERCENT.exec(text(r[col] ?? []))?.[1]);
    if (values.some((v) => v === undefined)) continue;
    const sum = values.reduce((s, v) => s + Number(v), 0);
    if (sum < 98 || sum > 102) continue;
    return {
      type: "mix",
      label: text(b.header[col] ?? []).trim(),
      rows: rows.map((r, i) => {
        const label = text(r[0] ?? []).trim();
        const others = r.filter((_, c) => c !== 0 && c !== col).filter((c) => text(c).trim());
        return {
          label,
          percent: values[i] as string,
          key: mixKey(label),
          note: others.flatMap((c, k) => (k ? [{ text: " · " }, ...c] : c)),
        };
      }),
    };
  }
  if (width === 2) {
    return {
      type: "pairs",
      header: [text(b.header[0] ?? []).trim(), text(b.header[1] ?? []).trim()],
      rows: rows.map((r) => ({ key: r[0] ?? [], value: r[1] ?? [] })),
    };
  }
  return { type: "table", header: b.header, rows };
}

function paragraphPart(spans: Span[]): Part {
  const all = trim(spans);
  const lead = all[0];
  // "**Glide path.** The mix stays..." is a note with a title.
  if (lead?.bold && /[.:]$/.test(lead.text.trim()) && lead.text.length <= 40 && all.length > 1) {
    return {
      type: "note",
      title: lead.text.trim().slice(0, -1),
      ...firstSentence(all.slice(1)),
    };
  }
  return { type: "note", ...firstSentence(all) };
}

function toPart(b: Block): Part | null {
  switch (b.type) {
    case "heading":
      return { type: "heading", spans: b.spans };
    case "paragraph":
      return paragraphPart(b.spans);
    case "list":
      return { type: "items", ordered: b.ordered, start: b.start, items: b.items.map(planItem) };
    case "table":
      return tablePart(b);
    default:
      return null;
  }
}

const REVIEWED = /^\s*(?:last\s+)?(?:reviewed|updated)(?:\s+on)?:?\s*(\d{4}-\d{2}-\d{2})\.?\s*/i;

function preview(parts: Part[]): PlanSection["preview"] {
  const mix = parts.find((p) => p.type === "mix");
  if (mix?.type === "mix") return { mix: mix.rows };
  // A list or table says more at a glance than the sentence that introduces it.
  const first =
    parts.find((p) => p.type === "items" || p.type === "pairs" || p.type === "table") ??
    parts.find((p) => p.type !== "heading");
  if (!first) return { text: "" };
  switch (first.type) {
    case "items":
      return { text: first.items.map((it) => text(it.head)).join(" · ") };
    case "pairs":
      return { text: first.rows.map((r) => text(r.key).trim()).join(" · ") };
    case "note":
      return { text: text(first.head) };
    case "table":
      return { text: first.rows.map((r) => text(r[0] ?? []).trim()).join(" · ") };
    default:
      return { text: "" };
  }
}

function count(parts: Part[]): number | null {
  const lists = parts.filter((p) => p.type === "items" || p.type === "pairs" || p.type === "table");
  if (lists.length !== 1) return null;
  const [p] = lists;
  if (p?.type === "items") return p.items.length;
  if (p?.type === "pairs" || p?.type === "table") return p.rows.length;
  return null;
}

export function planLayout(blocks: Block[]): PlanLayout {
  // The page already says "Plan", so a leading title is left out.
  const body = blocks[0]?.type === "heading" && blocks[0].level === 1 ? blocks.slice(1) : blocks;
  let reviewed: string | null = null;
  const intro: Part[] = [];
  const sections: { title: string; parts: Part[] }[] = [];
  for (const b of body) {
    if (b.type === "heading" && b.level <= 2) {
      sections.push({ title: text(b.spans).trim(), parts: [] });
      continue;
    }
    let block = b;
    if (!sections.length && !reviewed && b.type === "paragraph") {
      const first = b.spans[0];
      const m = first && !first.bold && !first.code ? REVIEWED.exec(first.text) : null;
      if (first && m?.[1]) {
        reviewed = m[1];
        const spans = trim([
          { ...first, text: first.text.slice(m[0].length) },
          ...b.spans.slice(1),
        ]);
        if (!spans.length) continue;
        block = { type: "paragraph", spans };
      }
    }
    const part = toPart(block);
    if (part) (sections.at(-1)?.parts ?? intro).push(part);
  }
  return {
    reviewed,
    intro,
    sections: sections.map((s) => ({
      ...s,
      preview: preview(s.parts),
      count: count(s.parts),
    })),
  };
}

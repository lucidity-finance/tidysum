import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, inject, it } from "vitest";
import { connect } from "../src/db/client.js";
import { financialPlan } from "../src/db/schema.js";
import { connectAgent } from "../src/mcp/agentDb.js";
import { firstSentence, planItem, planLayout } from "../src/plan/layout.js";
import { parseInline, parseMarkdown, planForPage, readPlan, setPlan } from "../src/plan/plan.js";
import { ownerUserId } from "./users.js";

describe("parseMarkdown", () => {
  it("reads headings, wrapped paragraphs, lists with continuation lines, and tables", () => {
    const md = [
      "# My plan",
      "",
      "Money works in the background",
      "so I can focus on my job.",
      "",
      "## Rules",
      "",
      "1. **Target mix** is 55% US",
      "   and 30% international.",
      "2. No margin.",
      "",
      "- one",
      "- two",
      "",
      "| Bucket | Target |",
      "| ------ | ------ |",
      "| US     | 55%    |",
      "| Bonds  | 10%    |",
      "",
      "After the table.",
    ].join("\n");
    expect(parseMarkdown(md)).toEqual([
      { type: "heading", level: 1, spans: [{ text: "My plan" }] },
      {
        type: "paragraph",
        spans: [{ text: "Money works in the background so I can focus on my job." }],
      },
      { type: "heading", level: 2, spans: [{ text: "Rules" }] },
      {
        type: "list",
        ordered: true,
        start: 1,
        items: [
          [{ text: "Target mix", bold: true }, { text: " is 55% US and 30% international." }],
          [{ text: "No margin." }],
        ],
      },
      { type: "list", ordered: false, start: 1, items: [[{ text: "one" }], [{ text: "two" }]] },
      {
        type: "table",
        header: [[{ text: "Bucket" }], [{ text: "Target" }]],
        rows: [
          [[{ text: "US" }], [{ text: "55%" }]],
          [[{ text: "Bonds" }], [{ text: "10%" }]],
        ],
      },
      { type: "paragraph", spans: [{ text: "After the table." }] },
    ]);
  });

  it("keeps only http(s) links, and leaves HTML as plain text", () => {
    expect(parseInline("see [IRS](https://irs.gov/x) and [bad](javascript:alert(1))")).toEqual([
      { text: "see " },
      { text: "IRS", href: "https://irs.gov/x" },
      { text: " and [bad](javascript:alert(1))" },
    ]);
    expect(parseInline("<script>x</script> `policy.json`")).toEqual([
      { text: "<script>x</script> " },
      { text: "policy.json", code: true },
    ]);
  });

  it("starts an ordered list at its first number", () => {
    expect(parseMarkdown("3. three\n4. four")).toEqual([
      { type: "list", ordered: true, start: 3, items: [[{ text: "three" }], [{ text: "four" }]] },
    ]);
  });
});

const owner = connect(inject("databaseUrl"));
const userId = await ownerUserId(owner.db);
const agentDb = connectAgent(inject("databaseUrl"), userId);

describe("planLayout", () => {
  const t = (spans: { text: string }[]) => spans.map((s) => s.text).join("");
  const long = (s: string) =>
    `${s} ${"Then a good deal more detail that the page keeps one click away.".repeat(2)}`;

  it("shows a long item's first sentence and keeps the rest", () => {
    const { head, more } = firstSentence(
      parseInline(long("Move the U.S. fund (about 0.27% a year. Really.) now.")),
    );
    expect(t(head)).toBe("Move the U.S. fund (about 0.27% a year. Really.) now.");
    expect(t(more)).toMatch(/^Then a good deal/);
    expect(firstSentence(parseInline("Short. Stays whole."))).toEqual({
      head: [{ text: "Short. Stays whole." }],
      more: [],
    });
  });

  it("turns a bold lead ending in a colon into a tag, and a bold sentence into the headline", () => {
    const tagged = planItem(
      parseInline(long("**Now, at Principal:** raise the base pay contribution.")),
    );
    expect(tagged.tag).toBe("Now, at Principal");
    expect(t(tagged.head)).toBe("Raise the base pay contribution.");
    const goal = planItem(parseInline("**Independent by 55.** Savings reach 25 times spending."));
    expect(goal).toEqual({
      head: [{ text: "Independent by 55.", bold: true }],
      more: [{ text: "Savings reach 25 times spending." }],
    });
  });

  it("folds each section, reads the review date, and turns tables into a mix or rows", () => {
    const md = [
      "# Plan",
      "",
      "> Last reviewed: 2026-01-15. Change it once a year.",
      "",
      "## Target mix",
      "",
      "| Bucket | Target | Where |",
      "| --- | --- | --- |",
      "| US stocks | 60% | an index fund |",
      "| International stocks | 30% | |",
      "| Bonds and cash | 10% | the 401(k) |",
      "",
      "**Glide path.** Bonds rise later.",
      "",
      "## Calendar",
      "",
      "| When | What |",
      "| --- | --- |",
      "| January | Review |",
      "| April | Taxes |",
      "",
      "## Rules",
      "",
      "1. Index funds only.",
      "2. No margin.",
    ].join("\n");
    const layout = planLayout(parseMarkdown(md));
    expect(layout.reviewed).toBe("2026-01-15");
    expect(layout.intro).toEqual([
      { type: "note", head: [{ text: "Change it once a year." }], more: [] },
    ]);
    const [mix, calendar, rules] = layout.sections;
    expect(mix?.preview).toEqual({
      mix: [
        { label: "US stocks", percent: "60", key: "us_stocks", note: [{ text: "an index fund" }] },
        { label: "International stocks", percent: "30", key: "intl_stocks", note: [] },
        {
          label: "Bonds and cash",
          percent: "10",
          key: "bonds_and_cash",
          note: [{ text: "the 401(k)" }],
        },
      ],
    });
    expect(mix?.parts[1]).toMatchObject({ type: "note", title: "Glide path" });
    expect(calendar).toMatchObject({
      title: "Calendar",
      count: 2,
      preview: { text: "January · April" },
      parts: [{ type: "pairs", header: ["When", "What"] }],
    });
    expect(rules).toMatchObject({ count: 2, preview: { text: "Index funds only. · No margin." } });
  });

  it("keeps a table of percentages that don't add up to a whole as a table", () => {
    const md = "| Fund | Fee | Yield |\n| - | - | - |\n| A | 1% | 2% |\n| B | 2% | 3% |";
    expect(planLayout(parseMarkdown(md.replaceAll("| - ", "| --- "))).intro[0]?.type).toBe("table");
  });
});

describe("plan storage", () => {
  afterEach(async () => {
    await owner.db.delete(financialPlan).where(eq(financialPlan.userId, userId));
  });
  afterAll(async () => {
    await agentDb.end();
    await owner.close();
  });

  it("is 'none' until the owner sets one", async () => {
    expect(await readPlan(agentDb)).toEqual({ state: "none" });
    expect(planForPage(await readPlan(agentDb))).toEqual({ state: "none" });
  });

  it("stores one plan per user, replaced whole, readable but not writable by agents", async () => {
    await setPlan(owner.db, userId, "# Plan\r\n\r\nFirst.\r\n");
    await setPlan(owner.db, userId, "# Plan\n\nSecond.\n");
    const r = await readPlan(agentDb);
    expect(r).toMatchObject({ state: "ready", markdown: "# Plan\n\nSecond." });
    expect(planForPage(r)).toMatchObject({
      state: "ready",
      reviewed: null,
      intro: [{ type: "note", head: [{ text: "Second." }], more: [] }],
      sections: [],
    });
    await expect(agentDb.query("update financial_plan set markdown = 'x'")).rejects.toThrow(
      /read-only transaction|permission denied/,
    );
  });

  it("refuses an empty plan", async () => {
    await expect(setPlan(owner.db, userId, "  \n ")).rejects.toThrow(/empty/);
  });
});

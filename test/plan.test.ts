import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, inject, it } from "vitest";
import { connect } from "../src/db/client.js";
import { financialPlan } from "../src/db/schema.js";
import { connectAgent } from "../src/mcp/agentDb.js";
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
      blocks: [
        { type: "heading", level: 1, spans: [{ text: "Plan" }] },
        { type: "paragraph", spans: [{ text: "Second." }] },
      ],
    });
    await expect(agentDb.query("update financial_plan set markdown = 'x'")).rejects.toThrow(
      /read-only transaction|permission denied/,
    );
  });

  it("refuses an empty plan", async () => {
    await expect(setPlan(owner.db, userId, "  \n ")).rejects.toThrow(/empty/);
  });
});

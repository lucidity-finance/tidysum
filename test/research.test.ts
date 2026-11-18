import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { connect } from "../src/db/client.js";
import { researchImport, researchRun } from "../src/db/schema.js";
import { connectAgent } from "../src/mcp/agentDb.js";
import { evaluatePolicy, validateProposal } from "../src/policy/engine.js";
import { parsePolicy } from "../src/policy/policy.js";
import type { Snapshot, SnapshotHolding } from "../src/policy/snapshot.js";
import { allocationForPage, buildAllocationReport } from "../src/portfolio/allocation.js";
import {
  type MinerSource,
  parseExport,
  parseRunList,
  pickRuns,
  type RunListing,
} from "../src/research/miner.js";
import {
  buildResearchReport,
  listLabel,
  readResearchReport,
  researchForPage,
} from "../src/research/report.js";
import { importResearch, readResearch } from "../src/research/store.js";
import { ownerUserId } from "./users.js";

const fixture = async (name: string) =>
  JSON.parse(await readFile(new URL(`fixtures/research/${name}`, import.meta.url), "utf8"));

const assets = await fixture("assets-completed.json");
const institutionalPartial = await fixture("institutional-partial.json");
const completed = (e: Record<string, unknown>, runId?: string) => {
  const copy = structuredClone(e) as { run: Record<string, unknown> };
  copy.run.status = "completed";
  if (runId) copy.run.run_id = runId;
  return copy;
};

describe("reading investment-miner", () => {
  it("parses list-runs, newest first", () => {
    const text = [
      "Past runs (3):",
      "",
      "  20261111_221500_oak-fern",
      "    Signals: 759, Tiers: 13f, prices, etf, insider, Watchlist: watchlist-institutional.yaml, Status: partial",
      "",
      "  20261111_220000_mesa-cider",
      "    Signals: 66, Tiers: prices, Watchlist: watchlist-assets.yaml, Status: completed",
      "",
      "  20260521_224729_pine-river",
      "    Signals: 156, Tiers: 13f, prices, etf, insider, Watchlist: watchlist-ai-scaling.yaml, Status: legacy",
      "",
    ].join("\n");
    expect(parseRunList(text)).toEqual([
      {
        run_id: "20261111_221500_oak-fern",
        watchlist: "watchlist-institutional.yaml",
        status: "partial",
      },
      {
        run_id: "20261111_220000_mesa-cider",
        watchlist: "watchlist-assets.yaml",
        status: "completed",
      },
      {
        run_id: "20260521_224729_pine-river",
        watchlist: "watchlist-ai-scaling.yaml",
        status: "legacy",
      },
    ]);
    expect(parseRunList("No runs found.\n")).toEqual([]);
  });

  it("tries completed and partial runs per watchlist, newest first; failed or running ones never", () => {
    const listing: RunListing[] = [
      { run_id: "d", watchlist: "w-inst", status: "running" },
      { run_id: "c", watchlist: "w-inst", status: "partial" },
      { run_id: "b", watchlist: "w-inst", status: "failed" },
      { run_id: "a2", watchlist: "w-assets", status: "completed" },
      { run_id: "a", watchlist: "w-inst", status: "completed" },
      { run_id: "z", watchlist: "w-legacy", status: "legacy" },
    ];
    expect(pickRuns(listing)).toEqual([
      { watchlist: "w-inst", newest: listing[0], usable: [listing[1], listing[4]] },
      { watchlist: "w-assets", newest: listing[3], usable: [listing[3]] },
      { watchlist: "w-legacy", newest: listing[5], usable: [] },
    ]);
  });

  it("accepts only export schema 2, and completed runs or partial ones that fetched 90%+", () => {
    expect(() => parseExport({ ...assets, schema_version: 1 })).toThrow(/schema_version 1/);
    expect(() => parseExport({ ...assets, schema_version: 3 })).toThrow(/only 2/);
    expect(() => parseExport({ run: assets.run, signals: [] })).toThrow(/schema_version undefined/);
    // The fixture fetched 98% of its sources: a few price fetches failed, the rest is there.
    const partial = parseExport(institutionalPartial);
    expect(partial.status).toBe("partial");
    expect(partial.coverage).toMatchObject({ ratio: expect.any(Number) });
    const thin = structuredClone(institutionalPartial);
    thin.run.coverage.ratio = 0.8;
    expect(() => parseExport(thin)).toThrow(
      /partial with 80% of its sources fetched.*isn't current/,
    );
    const unknown = structuredClone(institutionalPartial);
    delete unknown.run.coverage;
    expect(() => parseExport(unknown)).toThrow(/an unknown share/);
    const failed = structuredClone(institutionalPartial);
    failed.run.status = "failed";
    expect(() => parseExport(failed)).toThrow(/failed, not completed or partial/);
    const legacy = structuredClone(assets);
    delete legacy.run.status;
    expect(() => parseExport(legacy)).toThrow(/legacy/);
  });

  it("keeps the run's identity, as-of, status, scoring version and limitations", () => {
    const run = parseExport(assets);
    expect(run).toMatchObject({
      run_id: "20260922_194139_mesa-cider",
      product: "assets",
      watchlist: "watchlist-assets.yaml",
      status: "completed",
      scoring_version: "5",
      export_schema_version: 2,
      signal_count: 4,
    });
    expect(run.as_of.toISOString()).toBe("2026-09-22T19:41:39.327Z");
    // Ranked by price dislocation, ties by ticker, whatever order the export had.
    expect(run.candidates.map((c) => [c.rank, c.ticker, c.score])).toEqual([
      [1, "AVAV", "1"],
      [2, "RCAT", "1"],
      [3, "SLV", "0.9219"],
      [4, "CENX", "0.912"],
    ]);
    expect(run.candidates[2]?.summary).toMatch(/below its 52-week high\.$/);
  });

  it("ranks institutional picks by conviction and summarizes who holds them", () => {
    const run = parseExport(completed(institutionalPartial));
    expect(run.product).toBe("institutional");
    expect(run.warnings.length).toBeGreaterThan(0);
    const [first] = run.candidates;
    expect(first).toMatchObject({ rank: 1, ticker: "AMZN", score: "0.721" });
    expect(first?.summary).toMatch(/^Held by 17 tracked funds/);
    expect(first?.evidence).toMatchObject({ holders_count: 17 });
    expect(first?.evidence.top_holders).toEqual(expect.arrayContaining([expect.any(String)]));
  });
});

const owner = connect(inject("databaseUrl"));
const userId = await ownerUserId(owner.db);
const agentDb = connectAgent(inject("databaseUrl"), userId);

/** A miner that serves the given exports, counting how often each is exported. */
function fakeMiner(
  listing: RunListing[],
  exports: Record<string, unknown>,
): MinerSource & {
  exported: string[];
} {
  const exported: string[] = [];
  return {
    exported,
    listRuns: async () => listing,
    exportRun: async (id) => {
      exported.push(id);
      if (!(id in exports)) throw new Error(`Run not found: ${id}`);
      return exports[id];
    },
  };
}

describe("importing research", () => {
  beforeEach(async () => {
    await owner.db.delete(researchRun);
    await owner.db.delete(researchImport);
  });
  afterAll(async () => {
    await owner.db.delete(researchRun);
    await owner.db.delete(researchImport);
    await agentDb.end();
    await owner.close();
  });

  const instId = "20260920_221500_old-oak";
  const listing: RunListing[] = [
    {
      run_id: "20260922_182214_maple-hawk",
      watchlist: "watchlist-institutional.yaml",
      status: "partial",
    },
    {
      run_id: "20260922_194139_mesa-cider",
      watchlist: "watchlist-assets.yaml",
      status: "completed",
    },
    { run_id: instId, watchlist: "watchlist-institutional.yaml", status: "completed" },
  ];

  it("imports each watchlist's newest current run once, and agents can read it", async () => {
    const thin = structuredClone(institutionalPartial);
    thin.run.coverage.ratio = 0.5;
    const miner = fakeMiner(listing, {
      "20260922_194139_mesa-cider": assets,
      "20260922_182214_maple-hawk": thin,
      [instId]: completed(institutionalPartial, instId),
    });
    const first = await importResearch(owner.db, miner);
    expect(first).toMatchObject({ ok: true });
    expect(first.imported.sort()).toEqual([
      "20260920_221500_old-oak",
      "20260922_194139_mesa-cider",
    ]);
    // The newer partial run fetched too little, so the older completed one is used.
    expect(first.attempts).toContainEqual({
      watchlist: "watchlist-institutional.yaml",
      newest: { run_id: "20260922_182214_maple-hawk", status: "partial" },
      current: instId,
      skipped: [
        {
          run_id: "20260922_182214_maple-hawk",
          reason: expect.stringMatching(/50% of its sources/),
          rejected: true,
        },
      ],
    });
    const again = await importResearch(owner.db, miner);
    expect(again.imported).toEqual([]);
    // Neither the stored runs nor the rejected one are exported again.
    expect(miner.exported).toHaveLength(3);
    expect(again.attempts[0]?.skipped?.[0]?.rejected).toBe(true);
    const report = await readResearchReport(agentDb, "2026-09-23");
    if (report.state === "off") throw new Error("investing is on for the owner");
    expect(report.warnings.join(" ")).toMatch(/50% of its sources fetched.*showing 20260920/);

    const data = await readResearch(agentDb);
    expect(data.lists.map((l) => [l.product, l.run_id])).toEqual([
      ["assets", "20260922_194139_mesa-cider"],
      ["institutional", instId],
    ]);
    expect(data.lists[0]?.candidates[0]).toMatchObject({ rank: 1, ticker: "AVAV", score: "1" });
    expect(data.last_import).toMatchObject({ ok: true });
    await expect(agentDb.query("delete from research_run")).rejects.toThrow(
      /read-only transaction|permission denied/,
    );
  });

  it("uses a newer partial run that fetched most of its data, labeled partial", async () => {
    const miner = fakeMiner(listing, {
      "20260922_194139_mesa-cider": assets,
      "20260922_182214_maple-hawk": institutionalPartial,
      [instId]: completed(institutionalPartial, instId),
    });
    const r = await importResearch(owner.db, miner);
    expect(r.ok).toBe(true);
    expect(r.imported.sort()).toEqual(["20260922_182214_maple-hawk", "20260922_194139_mesa-cider"]);
    const report = await readResearchReport(agentDb, "2026-09-23", 2);
    if (report.state === "off") throw new Error("investing is on for the owner");
    // Institutional lists come first.
    expect(report.lists.map((l) => [l.product, l.run.status, l.run.fetched_pct])).toEqual([
      ["institutional", "partial", 98],
      ["assets", "completed", 100],
    ]);
    const inst = report.lists[0];
    // Biggest drops: the run's conviction picks, furthest below their 52-week high first.
    const drops = inst?.biggest_drops.map((c) => Number(c.drop_pct)) ?? [];
    expect(drops.length).toBeGreaterThan(0);
    expect(drops).toEqual([...drops].sort((a, b) => b - a));
    expect(report.lists[1]?.biggest_drops).toEqual([]);
    const page = researchForPage(report);
    if (page.state === "off") throw new Error("investing is on for the owner");
    expect(page.lists[0]?.run).toMatchObject({ status: "partial", fetched_pct: 98 });
    expect(page.lists[0]?.biggest_drops[0]).toMatchObject({ drop_pct: expect.any(String) });
  });

  it("records a miner it can't read, or an export it won't accept, without throwing", async () => {
    const down = await importResearch(owner.db, {
      listRuns: async () => {
        throw new Error("investment_miner list-runs failed: no such file");
      },
      exportRun: async () => ({}),
    });
    expect(down).toMatchObject({ ok: false, error: expect.stringMatching(/no such file/) });

    const wrong = await importResearch(
      owner.db,
      fakeMiner([listing[1] as RunListing], {
        "20260922_194139_mesa-cider": { ...assets, schema_version: 3 },
      }),
    );
    expect(wrong.ok).toBe(false);
    expect(wrong.attempts[0]?.error).toMatch(/schema_version 3/);
    expect((await readResearch(agentDb)).lists).toEqual([]);
  });

  it("reports the sleeve and the candidates to the owner's agents", async () => {
    await importResearch(
      owner.db,
      fakeMiner([listing[1] as RunListing], { "20260922_194139_mesa-cider": assets }),
    );
    const r = await readResearchReport(agentDb, "2026-11-11", 3);
    if (r.state === "off") throw new Error("investing is on for the owner");
    expect(r.state).toBe("ready");
    expect(r.stale).toBe(true);
    expect(r.newest_run_age_days).toBe(50);
    expect(r.lists[0]?.candidates).toHaveLength(3);
    expect(r.note).toMatch(/research evidence, not target weights/);
    expect(r.warnings.join(" ")).toMatch(/50 days old/);
    const page = researchForPage(r);
    expect(JSON.stringify(page)).not.toMatch(/\$|value_usd/);
  });
});

// The sleeve, the core mix and proposals -----------------------------------------------------

const BROKERAGE = "00000000-0000-4000-8000-000000000021";
const CHECKING = "00000000-0000-4000-8000-000000000022";

const sleevePolicy = (extra: Record<string, unknown> = {}) =>
  parsePolicy({
    version: 1,
    cash: { buffer: { amount: "1000.00" } },
    allocation: {
      buckets: {
        us_stocks: { target: "0.70", tickers: ["VTI"], security_types: ["equity"] },
        intl_stocks: { target: "0.30", tickers: ["VXUS"] },
      },
    },
    research_sleeve: { cap: "0.05", tickers: ["RCAT"] },
    ...extra,
  }).policy;

function h(ticker: string, value: string, type = "equity"): SnapshotHolding {
  return {
    account_id: BROKERAGE,
    security_id: `sec-${ticker}`,
    ticker_symbol: ticker,
    security_name: ticker,
    is_cash_equivalent: false,
    security_type: type,
    institution_value: value,
  };
}

function snap(holdings: SnapshotHolding[], tickers: string[] = ["AVAV", "RCAT", "NVDA"]): Snapshot {
  return {
    today: "2026-11-11",
    investing_enabled: true,
    accounts: [
      {
        id: BROKERAGE,
        name: "Brokerage",
        type: "investment",
        subtype: "brokerage",
        currency: "USD",
        current: null,
        available: null,
        balance_as_of: null,
      },
      {
        id: CHECKING,
        name: "Checking",
        type: "depository",
        subtype: "checking",
        currency: "USD",
        current: "20000.00",
        available: "20000.00",
        balance_as_of: "2026-11-11",
      },
    ],
    liabilities: [],
    holdings,
    spending: [],
    research: {
      runs: [
        {
          run_id: "r1",
          product: "assets",
          watchlist: "watchlist-assets.yaml",
          as_of: "2026-11-10T22:00:00Z",
        },
      ],
      tickers,
    },
  };
}

// 10,000 invested: RCAT (sleeve) 300, NVDA 1,700 (core, unlisted equity), VTI 5,000, VXUS 3,000.
const holdings = [
  h("RCAT", "300"),
  h("NVDA", "1700"),
  h("VTI", "5000", "etf"),
  h("VXUS", "3000", "etf"),
];

describe("research sleeve", () => {
  it("is optional, capped at a quarter, and can't share a ticker with a bucket", () => {
    expect(() => sleevePolicy({ research_sleeve: { cap: "0.3" } })).toThrow(/capped at 0.25/);
    expect(() => sleevePolicy({ research_sleeve: { cap: "0.05", tickers: ["vti"] } })).toThrow(
      /can't also be listed in a bucket/,
    );
    expect(sleevePolicy({ research_sleeve: undefined }).research_sleeve).toBeUndefined();
  });

  it("counts sleeve positions toward the cap, not toward the core buckets", () => {
    const r = buildAllocationReport(sleevePolicy(), snap(holdings));
    if ("empty" in r) throw new Error("expected a report");
    // Core is 9,700: US 6,700 (69.1%), intl 3,000 (30.9%).
    expect(r.buckets.map((b) => [b.key, b.current])).toEqual([
      ["us_stocks", "69.1"],
      ["intl_stocks", "30.9"],
    ]);
    expect(r.sleeve).toEqual({
      cap: "5.0",
      current: "3.0",
      room: "2.0",
      over: false,
      holdings: [{ ticker: "RCAT", name: "RCAT", percent: "3.0" }],
    });
    expect(allocationForPage({ state: "ready", ...r })).toMatchObject({
      sleeve: { cap: "5.0", current: "3.0", room: "2.0", over: false },
    });
    expect(JSON.stringify(allocationForPage({ state: "ready", ...r }))).not.toContain("RCAT");
  });

  it("says in check_policy where the sleeve stands and that scores aren't targets", () => {
    const findings = evaluatePolicy(sleevePolicy(), snap(holdings));
    const sleeve = findings.find((f) => f.key === "research_sleeve");
    expect(sleeve).toMatchObject({ status: "ok", category: "securities" });
    expect(sleeve?.summary).toMatch(/3\.0% of investable assets, under its 5\.0% cap/);
    expect(sleeve?.summary).toMatch(/research evidence, not target weights/);
    expect(findings.find((f) => f.key === "research_sleeve:freshness")).toBeUndefined();

    const over = evaluatePolicy(sleevePolicy(), snap([...holdings, h("RCAT", "500")]));
    expect(over.find((f) => f.key === "research_sleeve")).toMatchObject({ status: "warning" });

    const old = snap(holdings);
    if (old.research?.runs[0]) old.research.runs[0].as_of = "2026-10-01T22:00:00Z";
    expect(
      evaluatePolicy(sleevePolicy(), old).find((f) => f.key === "research_sleeve:freshness"),
    ).toMatchObject({ status: "warning", summary: expect.stringMatching(/41 days old/) });

    const off = evaluatePolicy(sleevePolicy(), { ...snap(holdings), investing_enabled: false });
    expect(off.some((f) => f.check === "research_sleeve")).toBe(false);
  });

  const buy = (symbol: string, amount: string) => ({
    kind: "trade" as const,
    from_account_id: BROKERAGE,
    side: "buy" as const,
    symbol,
    amount,
  });

  it("lets proposals buy into the sleeve only with new money and within the cap", () => {
    // Room: (0.05 * 10,000 - 300) / 0.95 = 210.53.
    const ok = validateProposal(sleevePolicy(), snap(holdings), [buy("AVAV", "200")]);
    expect(ok.violations).toEqual([]);
    expect(ok.warnings.join(" ")).toMatch(/Research sleeve buy: .*not target weights/);

    const over = validateProposal(sleevePolicy(), snap(holdings), [buy("RCAT", "250")]);
    expect(over.violations.join(" ")).toMatch(/takes it to 5\.4% .* over its 5\.0% cap/);

    const selling = validateProposal(sleevePolicy(), snap(holdings), [
      { ...buy("VTI", "100"), side: "sell" as const },
      buy("AVAV", "100"),
    ]);
    expect(selling.violations).toContain(
      "research sleeve buys come from new money only, not from selling",
    );

    // A ranked ticker a bucket lists is a core buy; an unranked one isn't the sleeve's business.
    const core = validateProposal(sleevePolicy(), snap(holdings, ["VTI"]), [buy("VTI", "5000")]);
    expect(core.violations).toEqual([]);
    const plain = validateProposal(sleevePolicy(), snap(holdings), [buy("MSFT", "5000")]);
    expect(plain.violations).toEqual([]);
    // Without a sleeve in the policy, none of this applies.
    const none = validateProposal(sleevePolicy({ research_sleeve: undefined }), snap(holdings), [
      buy("AVAV", "5000"),
    ]);
    expect(none.violations).toEqual([]);
  });

  it("shows a held ticker once, tagged, and lists sleeve positions the miner doesn't rank", () => {
    const run = parseExport(assets);
    const r = buildResearchReport(
      sleevePolicy({ research_sleeve: { cap: "0.05", tickers: ["RCAT", "ZZZ"] } }),
      snap([...holdings, h("ZZZ", "10"), h("AVAV", "100")]),
      {
        lists: [
          {
            ...run,
            as_of: "2026-11-10T19:41:39Z",
            completed_at: null,
            imported_at: "2026-11-10T23:00:00Z",
            candidates: run.candidates,
          },
        ],
        last_import: null,
      },
    );
    if (r.state === "off") throw new Error("investing is on");
    expect(r.lists[0]?.candidates.map((c) => [c.ticker, c.held])).toEqual([
      ["AVAV", "core"],
      ["RCAT", "sleeve"],
      ["SLV", null],
      ["CENX", null],
    ]);
    expect(r.sleeve?.ranked_elsewhere).toBe(1);
    expect(r.sleeve_not_ranked.map((x) => x.ticker)).toEqual(["ZZZ"]);
    expect(r.stale).toBe(false);
    expect(r.warnings).toContain("investment-miner hasn't been read yet.");
    expect(
      buildResearchReport(
        sleevePolicy(),
        { ...snap(holdings), investing_enabled: false },
        {
          lists: [],
          last_import: null,
        },
      ),
    ).toEqual({ state: "off", as_of: "2026-11-11" });
  });

  it("names lists by product and watchlist", () => {
    expect(listLabel("institutional", "watchlist-institutional.yaml")).toBe("Institutional picks");
    expect(listLabel("institutional", "watchlist-ai-scaling.yaml")).toBe(
      "Institutional picks (AI scaling)",
    );
    expect(listLabel("assets", "watchlist-assets.yaml")).toBe("Good asset watchlist");
  });
});

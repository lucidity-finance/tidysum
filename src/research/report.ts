import type { AgentDb } from "../mcp/agentDb.js";
import { ageInDays, RESEARCH_NOTE, RESEARCH_STALE_DAYS } from "../policy/engine.js";
import type { Policy } from "../policy/policy.js";
import { readSnapshot, type Snapshot } from "../policy/snapshot.js";
import { loadActivePolicy } from "../policy/store.js";
import { type SleeveSummary, sleeveSummary } from "../portfolio/allocation.js";
import { investableHoldings, splitSleeve } from "../portfolio/investable.js";
import { CANDIDATES_PER_RUN, type UsableStatus } from "./miner.js";
import {
  type ImportAttempt,
  type ResearchData,
  readResearch,
  type StoredCandidate,
} from "./store.js";

// investment-miner's latest research, put next to the owner's research sleeve. Investment
// advice, so it only runs for users with investing enabled (decision 0003). The miner ranks;
// it doesn't size anything. Its scores are research evidence, never a target weight.

const PRODUCT_LABEL = { institutional: "Institutional picks", assets: "Good asset watchlist" };
const RANKED_BY = {
  institutional:
    "conviction (overlap, position size, accumulation and insider buys of tracked funds)",
  assets: "price dislocation (how far below its 52-week high)",
};
const DEFAULT_WATCHLIST = {
  institutional: "watchlist-institutional.yaml",
  assets: "watchlist-assets.yaml",
};

/** "Institutional picks (AI scaling)" for a non-default watchlist. */
export function listLabel(product: "institutional" | "assets", watchlist: string): string {
  if (watchlist === DEFAULT_WATCHLIST[product]) return PRODUCT_LABEL[product];
  const theme = watchlist
    .replace(/\.ya?ml$/i, "")
    .replace(/^watchlist-/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  const nice = theme.replace(/\bai\b/gi, "AI").replace(/^./, (c) => c.toUpperCase());
  return theme ? `${PRODUCT_LABEL[product]} (${nice})` : PRODUCT_LABEL[product];
}

export type Held = "sleeve" | "core" | null;

export interface ResearchList {
  label: string;
  product: "institutional" | "assets";
  watchlist: string;
  ranked_by: string;
  run: {
    run_id: string;
    /** "partial" when some fetches failed but at least 90% of its sources came back. */
    status: UsableStatus;
    /** Share of the run's requested sources the miner fetched, as a whole percent. */
    fetched_pct: number | null;
    as_of: string;
    age_days: number;
    stale: boolean;
    scoring_version: string | null;
    export_schema_version: number;
    limitations: string[];
    warnings: string[];
    coverage: Record<string, unknown> | null;
    signal_count: number;
  };
  /**
   * Ranked, best first. `held` says the owner already holds it: in the research sleeve, or
   * elsewhere (core). Each ticker shows here once; sleeve positions the miner ranks aren't
   * listed again under the sleeve.
   */
  candidates: Candidate[];
  /**
   * Institutional lists only: of the run's top conviction picks (up to 50), the ones furthest
   * below their 52-week high, biggest drop first. Big funds own them and their price is down;
   * that is research to look into, not a reason on its own to buy.
   */
  biggest_drops: Candidate[];
}

export type Candidate = StoredCandidate & {
  held: Held;
  /** How far below its 52-week high, as a whole percent string; null when unknown. */
  drop_pct: string | null;
};

const dropOf = (c: StoredCandidate): string | null => {
  const v = c.evidence.drawdown_from_high_pct;
  return typeof v === "string" && /^-?\d+$/.test(v) ? v : null;
};

export type ResearchReport =
  | { state: "off"; as_of: string }
  | {
      state: "ready" | "no_runs";
      as_of: string;
      note: string;
      /** null when the policy has no research_sleeve: then nothing may be bought from these lists. */
      sleeve: (SleeveSummary & { ranked_elsewhere: number }) | null;
      newest_run_age_days: number | null;
      stale: boolean;
      lists: ResearchList[];
      /** Sleeve positions no current list ranks. */
      sleeve_not_ranked: SleeveSummary["holdings"];
      last_import: ResearchData["last_import"];
      warnings: string[];
    };

/** Why a newer run isn't the current one, from the last import's per-watchlist attempts. */
function attemptWarnings(attempts: ImportAttempt[]): string[] {
  const out: string[] = [];
  const showing = (a: ImportAttempt) => (a.current ? `; showing ${a.current}` : "");
  for (const a of attempts) {
    if (a.error) out.push(`${a.watchlist}: ${a.error}`);
    if (a.newest.run_id === a.current) continue;
    const skipped = a.skipped?.find((s) => s.run_id === a.newest.run_id);
    if (skipped) {
      if (skipped.rejected) out.push(`${a.watchlist}: ${skipped.reason}${showing(a)}.`);
      continue;
    }
    const status =
      a.newest.status === "legacy"
        ? "from an older miner version"
        : a.newest.status === "running"
          ? "still running"
          : a.newest.status;
    out.push(
      `${a.watchlist}: the newest run (${a.newest.run_id}) is ${status}, so it isn't used${showing(a)}.`,
    );
  }
  return out;
}

export function buildResearchReport(
  policy: Policy | null,
  snapshot: Snapshot,
  research: ResearchData,
  limit = 10,
): ResearchReport {
  const today = snapshot.today;
  if (!snapshot.investing_enabled) return { state: "off", as_of: today };

  const sleeve = policy ? sleeveSummary(policy, snapshot) : null;
  const sleeveSet = new Set(
    (sleeve?.holdings ?? []).map((h) => h.ticker?.toUpperCase()).filter((t): t is string => !!t),
  );
  const coreSet = new Set<string>();
  if (policy) {
    const { core } = splitSleeve(policy, investableHoldings(policy, snapshot).holdings);
    for (const h of core) if (h.ticker_symbol) coreSet.add(h.ticker_symbol.toUpperCase());
  }
  const heldAs = (t: string): Held =>
    sleeveSet.has(t.toUpperCase()) ? "sleeve" : coreSet.has(t.toUpperCase()) ? "core" : null;

  const withHeld = (c: StoredCandidate): Candidate => ({
    ...c,
    held: heldAs(c.ticker),
    drop_pct: dropOf(c),
  });
  const PRODUCT_ORDER = { institutional: 0, assets: 1 };
  const ordered = [...research.lists].sort(
    (a, b) => PRODUCT_ORDER[a.product] - PRODUCT_ORDER[b.product],
  );
  const lists: ResearchList[] = ordered.map((r) => {
    const age = ageInDays(r.as_of, today);
    const ratio = r.coverage?.ratio;
    return {
      label: listLabel(r.product, r.watchlist),
      product: r.product,
      watchlist: r.watchlist,
      ranked_by: RANKED_BY[r.product],
      run: {
        run_id: r.run_id,
        status: r.status,
        fetched_pct:
          typeof ratio === "number" && Number.isFinite(ratio) ? Math.floor(ratio * 100) : null,
        as_of: r.as_of,
        age_days: age,
        stale: age > RESEARCH_STALE_DAYS,
        scoring_version: r.scoring_version,
        export_schema_version: r.export_schema_version,
        limitations: r.limitations,
        warnings: r.warnings,
        coverage: r.coverage,
        signal_count: r.signal_count,
      },
      candidates: r.candidates.slice(0, limit).map(withHeld),
      biggest_drops:
        r.product === "institutional"
          ? r.candidates
              .map(withHeld)
              .filter((c) => c.drop_pct !== null && Number(c.drop_pct) > 0)
              .sort((x, y) => Number(y.drop_pct) - Number(x.drop_pct) || x.rank - y.rank)
              .slice(0, limit)
          : [],
    };
  });

  const ranked = new Set(
    lists.flatMap((l) => [...l.candidates, ...l.biggest_drops].map((c) => c.ticker.toUpperCase())),
  );
  const newest = lists.map((l) => l.run.age_days).sort((a, b) => a - b)[0] ?? null;
  const stale = newest === null || newest > RESEARCH_STALE_DAYS;
  const warnings = [
    ...(research.last_import && !research.last_import.ok && research.last_import.error
      ? [`The last read of investment-miner failed: ${research.last_import.error}`]
      : []),
    ...attemptWarnings(research.last_import?.attempts ?? []),
  ];
  if (!research.last_import) warnings.push("investment-miner hasn't been read yet.");
  if (newest !== null && stale) {
    warnings.push(
      `The newest completed run is ${newest} days old, so these candidates may be out of date.`,
    );
  }
  return {
    state: lists.length ? "ready" : "no_runs",
    as_of: today,
    note: `${RESEARCH_NOTE} Only the research sleeve may hold them, bought with new money and within its cap; the core mix is unaffected.`,
    sleeve: sleeve && {
      ...sleeve,
      ranked_elsewhere: sleeve.holdings.filter(
        (h) => h.ticker && ranked.has(h.ticker.toUpperCase()),
      ).length,
    },
    newest_run_age_days: newest,
    stale,
    lists,
    sleeve_not_ranked: (sleeve?.holdings ?? []).filter(
      (h) => !h.ticker || !ranked.has(h.ticker.toUpperCase()),
    ),
    last_import: research.last_import,
    warnings,
  };
}

/** The session user's research report, read through row-level security. */
export async function readResearchReport(
  db: AgentDb,
  today: string,
  limit = 10,
): Promise<ResearchReport> {
  const snapshot = await readSnapshot(db, today);
  if (!snapshot.investing_enabled) return { state: "off", as_of: today };
  const { rows } = await db.query("select 1 from policy_version limit 1");
  const policy = rows.length ? (await loadActivePolicy(db)).policy : null;
  return buildResearchReport(policy, snapshot, await readResearch(db, CANDIDATES_PER_RUN), limit);
}

/**
 * What the admin page shows: the sleeve against its cap and the top candidates with a one-line
 * summary each. No dollar amounts; the owner's own positions only appear as a tag on a
 * candidate the miner ranks.
 */
const pageCandidate = (c: Candidate) => ({
  rank: c.rank,
  ticker: c.ticker,
  name: c.name,
  score: c.score,
  summary: c.summary,
  drop_pct: c.drop_pct,
  held: c.held,
});

export function researchForPage(r: ResearchReport) {
  if (r.state === "off") return r;
  return {
    state: r.state,
    as_of: r.as_of,
    note: r.note,
    sleeve: r.sleeve && {
      cap: r.sleeve.cap,
      current: r.sleeve.current,
      room: r.sleeve.room,
      over: r.sleeve.over,
    },
    stale: r.stale,
    newest_run_age_days: r.newest_run_age_days,
    /** Whether investment-miner has been read at all (it isn't set up otherwise). */
    read: r.last_import !== null,
    lists: r.lists.map((l) => ({
      label: l.label,
      product: l.product,
      ranked_by: l.ranked_by,
      run: {
        run_id: l.run.run_id,
        as_of: l.run.as_of,
        age_days: l.run.age_days,
        stale: l.run.stale,
        status: l.run.status,
        fetched_pct: l.run.fetched_pct,
        scoring_version: l.run.scoring_version,
        limitations: l.run.limitations,
        warnings: l.run.warnings,
      },
      candidates: l.candidates.map(pageCandidate),
      biggest_drops: l.biggest_drops.map(pageCandidate),
    })),
    warnings: r.warnings,
  };
}

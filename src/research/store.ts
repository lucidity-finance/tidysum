import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { researchCandidate, researchImport, researchRun } from "../db/schema.js";
import type { AgentDb } from "../mcp/agentDb.js";
import {
  type MinerSource,
  type ParsedRun,
  parseExport,
  pickRuns,
  type UsableStatus,
} from "./miner.js";

// Imports the miner's newest current run per watchlist and reads it back for agents and the
// admin page. The import runs on the owner side (it writes); reads run as tidysum_agent.

/** Runs kept per watchlist, so a bad newer import never leaves nothing to compare against. */
const RUNS_KEPT = 5;

export interface ImportAttempt {
  watchlist: string;
  /** The newest run the miner listed for this watchlist, whatever its status. */
  newest: { run_id: string; status: string };
  /** The run Tidysum uses: the newest completed or well-covered partial one; null if none. */
  current: string | null;
  /** Newer runs that weren't used, and why. `rejected` is final (the run is too thin, say). */
  skipped?: { run_id: string; reason: string; rejected: boolean }[];
  /** Why no run could be imported, when none could. */
  error?: string;
}

export interface ImportResult {
  ok: boolean;
  imported: string[];
  attempts: ImportAttempt[];
  error?: string;
}

async function saveRun(db: Db, run: ParsedRun): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(researchRun).where(eq(researchRun.runId, run.run_id));
    await tx.insert(researchRun).values({
      runId: run.run_id,
      product: run.product,
      watchlist: run.watchlist,
      status: run.status,
      scoringVersion: run.scoring_version,
      exportSchemaVersion: run.export_schema_version,
      asOf: run.as_of,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      limitations: run.limitations,
      warnings: run.warnings,
      coverage: run.coverage,
      signalCount: run.signal_count,
    });
    if (run.candidates.length) {
      await tx.insert(researchCandidate).values(
        run.candidates.map((c) => ({
          runId: run.run_id,
          rank: c.rank,
          ticker: c.ticker,
          name: c.name,
          score: c.score,
          scoreCoverage: c.score_coverage,
          summary: c.summary,
          evidence: c.evidence,
        })),
      );
    }
    // Older runs of the same list beyond the few kept.
    const keep = await tx
      .select({ id: researchRun.runId })
      .from(researchRun)
      .where(and(eq(researchRun.product, run.product), eq(researchRun.watchlist, run.watchlist)))
      .orderBy(desc(researchRun.asOf))
      .limit(RUNS_KEPT);
    await tx.delete(researchRun).where(
      and(
        eq(researchRun.product, run.product),
        eq(researchRun.watchlist, run.watchlist),
        notInArray(
          researchRun.runId,
          keep.map((k) => k.id),
        ),
      ),
    );
  });
}

/**
 * Reads the miner's run list, exports each watchlist's newest completed run that isn't stored
 * yet, and records the attempt. Never throws for a miner problem: the failure is recorded (and
 * returned) so the admin page can say the research is out of date and why.
 */
export async function importResearch(db: Db, source: MinerSource): Promise<ImportResult> {
  const record = async (r: ImportResult) => {
    await db.insert(researchImport).values({
      ok: r.ok,
      error: r.error?.slice(0, 2000) ?? null,
      attempts: r.attempts,
      imported: r.imported,
    });
    return r;
  };
  let listing: Awaited<ReturnType<MinerSource["listRuns"]>>;
  try {
    listing = await source.listRuns();
  } catch (err) {
    return record({ ok: false, imported: [], attempts: [], error: (err as Error).message });
  }
  const picks = pickRuns(listing);
  const wanted = picks.flatMap((p) => p.usable.map((r) => r.run_id));
  const stored = new Set(
    wanted.length
      ? (
          await db
            .select({ id: researchRun.runId })
            .from(researchRun)
            .where(inArray(researchRun.runId, wanted))
        ).map((r) => r.id)
      : [],
  );
  // A finished run never changes, so one rejected last time (too thin, say) isn't exported again.
  const [previous] = await db
    .select({ attempts: researchImport.attempts })
    .from(researchImport)
    .orderBy(desc(researchImport.id))
    .limit(1);
  const rejected = new Map(
    ((previous?.attempts ?? []) as ImportAttempt[])
      .flatMap((a) => a.skipped ?? [])
      .filter((s) => s.rejected)
      .map((s) => [s.run_id, s] as const),
  );
  const imported: string[] = [];
  const attempts: ImportAttempt[] = [];
  for (const p of picks) {
    const attempt: ImportAttempt = {
      watchlist: p.watchlist,
      newest: { run_id: p.newest.run_id, status: p.newest.status },
      current: null,
    };
    attempts.push(attempt);
    const skipped: NonNullable<ImportAttempt["skipped"]> = [];
    for (const candidate of p.usable) {
      if (stored.has(candidate.run_id)) {
        attempt.current = candidate.run_id;
        break;
      }
      const known = rejected.get(candidate.run_id);
      if (known) {
        skipped.push(known);
        continue;
      }
      let run: ParsedRun;
      try {
        run = parseExport(await source.exportRun(candidate.run_id));
      } catch (err) {
        const reason = (err as Error).message.slice(0, 500);
        // parseExport's refusals are about the run itself; anything else may pass next time.
        skipped.push({ run_id: candidate.run_id, reason, rejected: /isn't current/.test(reason) });
        continue;
      }
      try {
        if (run.run_id !== candidate.run_id) {
          throw new Error(`asked for run ${candidate.run_id}, got ${run.run_id}`);
        }
        await saveRun(db, run);
        imported.push(run.run_id);
        attempt.current = run.run_id;
        break;
      } catch (err) {
        skipped.push({
          run_id: candidate.run_id,
          reason: (err as Error).message.slice(0, 500),
          rejected: false,
        });
      }
    }
    if (skipped.length) attempt.skipped = skipped;
    const unexpected = skipped.find((s) => !s.rejected);
    if (unexpected) attempt.error = `run ${unexpected.run_id}: ${unexpected.reason}`;
  }
  const failed = attempts.filter((a) => a.error);
  return record({
    ok: failed.length === 0,
    imported,
    attempts,
    ...(failed.length ? { error: failed.map((a) => `${a.watchlist}: ${a.error}`).join("; ") } : {}),
  });
}

// Reading -----------------------------------------------------------------------------------

/** Older than this, the newest run is flagged as stale: the miner scans every weekday. */
export const STALE_AFTER_DAYS = 14;

export interface StoredCandidate {
  rank: number;
  ticker: string;
  name: string | null;
  score: string | null;
  score_coverage: string | null;
  summary: string;
  evidence: Record<string, unknown>;
}

export interface StoredRun {
  run_id: string;
  product: "institutional" | "assets";
  watchlist: string;
  status: UsableStatus;
  scoring_version: string | null;
  export_schema_version: number;
  as_of: string;
  completed_at: string | null;
  limitations: string[];
  warnings: string[];
  coverage: Record<string, unknown> | null;
  signal_count: number;
  imported_at: string;
}

export interface ResearchData {
  /** The newest stored run of each list, newest first, each with its top candidates. */
  lists: (StoredRun & { candidates: StoredCandidate[] })[];
  last_import: {
    at: string;
    ok: boolean;
    error: string | null;
    attempts: ImportAttempt[];
  } | null;
}

/** The newest stored run per (product, watchlist), with up to `limit` candidates each. */
export async function readResearch(db: AgentDb, limit = 50): Promise<ResearchData> {
  const runs = await db.query<StoredRun>(
    `select distinct on (product, watchlist)
       run_id, product, watchlist, status, scoring_version, export_schema_version,
       to_char(as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as as_of,
       to_char(completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as completed_at,
       limitations, warnings, coverage, signal_count,
       to_char(imported_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as imported_at
     from research_run
     order by product, watchlist, as_of desc`,
  );
  const ids = runs.rows.map((r) => r.run_id);
  const candidates = ids.length
    ? await db.query<StoredCandidate & { run_id: string }>(
        `select run_id, rank, ticker, name, score::text as score,
           score_coverage::text as score_coverage, summary, evidence
         from research_candidate
         where run_id = any($1::text[]) and rank <= $2
         order by run_id, rank`,
        [ids, limit],
      )
    : { rows: [] };
  const last = await db.query<{
    at: string;
    ok: boolean;
    error: string | null;
    attempts: ImportAttempt[];
  }>(
    `select to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at, ok, error, attempts
     from research_import order by id desc limit 1`,
  );
  const lists = runs.rows
    .map((r) => ({
      ...r,
      candidates: candidates.rows
        .filter((c) => c.run_id === r.run_id)
        .map(({ run_id: _, ...c }) => c),
    }))
    .sort((a, b) => (a.as_of < b.as_of ? 1 : a.as_of > b.as_of ? -1 : 0));
  return { lists, last_import: last.rows[0] ?? null };
}

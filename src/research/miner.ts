import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// investment-miner is the owner's separate research tool (Python, SQLite). Tidysum never reads
// its database: it reads saved runs through the miner's own read-only CLI (`list-runs`, and
// `export --format json`, whose contract is the miner's docs/RESULTS.md) and keeps only what the
// research sleeve needs. Only export schema 2 is accepted. A completed run is current, and so is
// a partial one whose fetches mostly worked: the miner marks a run partial when even a handful of
// its hundreds of price fetches fail, which is most institutional runs. Anything else isn't.

/** The export schema this code understands. Anything else is rejected, not guessed at. */
export const EXPORT_SCHEMA_VERSION = 2;

/** Candidates kept per run; the rest of a run's ranking stays in the miner. */
export const CANDIDATES_PER_RUN = 50;

/** Run statuses that can be current. */
export type UsableStatus = "completed" | "partial";

/**
 * A partial run is current only when at least this share of its requested sources were fetched
 * (the export's run.coverage.ratio). Below it, too much of the evidence is missing.
 */
export const MIN_PARTIAL_COVERAGE = 0.9;

/** Older usable runs tried per watchlist when a newer one can't be read or is too thin. */
export const RUNS_TRIED = 3;

export type Product = "institutional" | "assets";

/** One line of `list-runs`: newest first. */
export interface RunListing {
  run_id: string;
  watchlist: string;
  status: string;
}

export interface MinerSource {
  /** Every saved run, newest first. */
  listRuns(): Promise<RunListing[]>;
  /** The run's schema export, parsed JSON. */
  exportRun(runId: string): Promise<unknown>;
}

export interface ParsedCandidate {
  rank: number;
  ticker: string;
  name: string | null;
  /** Decimal strings from 0 to 1, or null when unavailable. */
  score: string | null;
  score_coverage: string | null;
  summary: string;
  evidence: Record<string, unknown>;
}

export interface ParsedRun {
  run_id: string;
  product: Product;
  watchlist: string;
  status: UsableStatus;
  scoring_version: string | null;
  export_schema_version: number;
  as_of: Date;
  started_at: Date;
  completed_at: Date | null;
  limitations: string[];
  warnings: string[];
  coverage: Record<string, unknown> | null;
  signal_count: number;
  candidates: ParsedCandidate[];
}

const RUN_ID = /^[A-Za-z0-9_.-]{1,80}$/;
const TICKER = /^[A-Z0-9][A-Z0-9.^=-]{0,14}$/;

/**
 * Parses `investment_miner list-runs`:
 *
 *   20260521_224729_pine-river
 *     Signals: 156, Tiers: 13f, prices, etf, insider, Watchlist: watchlist-ai-scaling.yaml, Status: legacy
 */
export function parseRunList(text: string): RunListing[] {
  const runs: RunListing[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const id = lines[i]?.trim() ?? "";
    const detail = lines[i + 1] ?? "";
    const m = /Watchlist: (.+), Status: (\S+)\s*$/.exec(detail);
    if (!RUN_ID.test(id) || !detail.trimStart().startsWith("Signals:") || !m) continue;
    runs.push({ run_id: id, watchlist: (m[1] ?? "").trim(), status: m[2] ?? "" });
    i++;
  }
  return runs;
}

/**
 * The runs that could be current for each watchlist, newest first: completed or partial ones (a
 * partial run still has to pass the coverage check in parseExport). A failed, interrupted,
 * running or legacy run never is, even when it is newer; it is reported as the newest attempt.
 */
export function pickRuns(listing: RunListing[]): {
  watchlist: string;
  newest: RunListing;
  usable: RunListing[];
}[] {
  const byWatchlist = new Map<string, { newest: RunListing; usable: RunListing[] }>();
  for (const r of listing) {
    if (!byWatchlist.has(r.watchlist)) byWatchlist.set(r.watchlist, { newest: r, usable: [] });
    const entry = byWatchlist.get(r.watchlist);
    if (entry && entry.usable.length < RUNS_TRIED && isUsable(r.status)) entry.usable.push(r);
  }
  return [...byWatchlist].map(([watchlist, v]) => ({ watchlist, ...v }));
}

const isUsable = (status: unknown): status is UsableStatus =>
  status === "completed" || status === "partial";

const isoish = z.string().transform((s, ctx) => {
  // The miner writes "2026-09-22 19:41:39.327577+00:00".
  const d = new Date(s.trim().replace(" ", "T"));
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: "custom", message: `not a timestamp: ${s}` });
    return z.NEVER;
  }
  return d;
});

const Envelope = z.object({
  schema_version: z.number(),
  run: z
    .object({
      run_id: z.string().regex(RUN_ID),
      run_type: z.string().nullish(),
      status: z.string().nullish(),
      scoring_version: z.union([z.string(), z.number()]).nullish(),
      as_of: isoish.nullish(),
      started_at: isoish,
      completed_at: isoish.nullish(),
      watchlist_path: z.string().nullish(),
      limitations: z.array(z.string()).nullish(),
      fetch_warnings: z.array(z.string()).nullish(),
      coverage: z.record(z.string(), z.unknown()).nullish(),
    })
    .passthrough(),
  signals: z.array(
    z
      .object({
        signal: z.record(z.string(), z.unknown()),
        holders: z.array(z.record(z.string(), z.unknown())).nullish(),
        price: z.record(z.string(), z.unknown()).nullish(),
      })
      .passthrough(),
  ),
  limitations: z.array(z.string()).nullish(),
});

/** A 0..1 score as a decimal string; null when unavailable or out of the contract's range. */
function unit(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) return null;
  return String(Number(v.toFixed(6)));
}

const text = (v: unknown, max = 120) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

/** "11" from 0.1115: a fraction as a whole percent. */
const wholePct = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 100)) : null;

const COMPONENTS = ["manager_overlap", "position_sizing", "accumulation", "insider"] as const;

function institutionalEvidence(
  signal: Record<string, unknown>,
  holders: Record<string, unknown>[],
  price: Record<string, unknown> | null,
) {
  const availability = (signal.component_availability ?? {}) as Record<string, unknown>;
  const components = Object.fromEntries(
    COMPONENTS.map((c) => [
      c,
      { score: unit(signal[`${c}_score`]), availability: text(availability[c], 30) },
    ]),
  );
  const top = [...holders]
    .sort((a, b) => Number(b.value_usd ?? 0) - Number(a.value_usd ?? 0))
    .map((h) => text(h.manager_name, 80))
    .filter((n): n is string => !!n)
    .filter((n, i, all) => all.indexOf(n) === i)
    .slice(0, 3);
  const count =
    typeof signal.holders_count === "number" ? signal.holders_count : holders.length || null;
  const drawdown = wholePct(signal.drawdown_from_high);
  const accumulation = components.accumulation;
  const parts = [
    count !== null ? `Held by ${count} tracked fund${count === 1 ? "" : "s"}` : null,
    accumulation?.availability === "observed" &&
    accumulation.score &&
    Number(accumulation.score) > 0
      ? "added to over recent quarters"
      : null,
    drawdown !== null ? `${drawdown}% below its 52-week high` : null,
  ].filter(Boolean);
  return {
    summary: parts.length ? `${parts.join(", ")}.` : "No evidence summary in the export.",
    evidence: {
      holders_count: count,
      top_holders: top,
      components,
      latest_filing_date: text(signal.latest_filing_date, 30),
      drawdown_from_high_pct: drawdown,
      price_observed_at: text(price?.observed_at, 40),
    },
  };
}

function assetEvidence(signal: Record<string, unknown>, price: Record<string, unknown> | null) {
  const drawdown = wholePct(signal.drawdown_from_high);
  const range = wholePct(signal.range_position_score);
  const assetClass = text(signal.asset_class, 60);
  return {
    // The asset's own name says what it is; its watchlist class stays in the evidence.
    summary: drawdown !== null ? `${drawdown}% below its 52-week high.` : "No price in the export.",
    evidence: {
      asset_class: assetClass,
      drawdown_from_high_pct: drawdown,
      range_position_pct: range,
      price_availability: text(price?.availability, 30),
      price_observed_at: text(price?.observed_at, 40),
    },
  };
}

/**
 * Validates a schema-2 export and keeps the top candidates with their evidence. Throws on any
 * other schema version, a run that is neither completed nor a well-covered partial run, or a run
 * of another product.
 */
export function parseExport(json: unknown, limit = CANDIDATES_PER_RUN): ParsedRun {
  const version = (json as { schema_version?: unknown } | null)?.schema_version;
  if (version !== EXPORT_SCHEMA_VERSION) {
    throw new Error(
      `unsupported investment-miner export schema_version ${JSON.stringify(version)}; only ${EXPORT_SCHEMA_VERSION} is accepted`,
    );
  }
  const parsed = Envelope.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `investment-miner export doesn't match schema 2: ${issue?.path.join(".")}: ${issue?.message}`,
    );
  }
  const { run, signals } = parsed.data;
  const status = run.status;
  if (!isUsable(status)) {
    throw new Error(
      `run ${run.run_id} is ${status ?? "legacy (no status)"}, not completed or partial, so it isn't current`,
    );
  }
  if (status === "partial") {
    const ratio = run.coverage?.ratio;
    if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < MIN_PARTIAL_COVERAGE) {
      const got = typeof ratio === "number" ? `${Math.floor(ratio * 100)}%` : "an unknown share";
      throw new Error(
        `run ${run.run_id} is partial with ${got} of its sources fetched, under ${MIN_PARTIAL_COVERAGE * 100}%, so it isn't current`,
      );
    }
  }
  const product = run.run_type;
  if (product !== "institutional" && product !== "assets") {
    throw new Error(
      `run ${run.run_id} is a ${product ?? "unknown"} run, not institutional or assets`,
    );
  }
  const scoreKey = product === "institutional" ? "conviction_score" : "price_dislocation_score";
  const ranked = signals
    .map((s) => ({ s, score: unit(s.signal[scoreKey]), ticker: text(s.signal.ticker, 20) }))
    .filter((r): r is typeof r & { ticker: string } => !!r.ticker && TICKER.test(r.ticker))
    // The miner's own order: saved score descending, unavailable last, ticker breaks ties.
    .sort((a, b) => {
      if (a.score === null || b.score === null) {
        if (a.score !== b.score) return a.score === null ? 1 : -1;
      } else if (a.score !== b.score) return Number(b.score) - Number(a.score);
      return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
    });

  const candidates = ranked.slice(0, limit).map((r, i): ParsedCandidate => {
    const price = (r.s.price ?? null) as Record<string, unknown> | null;
    const { summary, evidence } =
      product === "institutional"
        ? institutionalEvidence(r.s.signal, r.s.holders ?? [], price)
        : assetEvidence(r.s.signal, price);
    return {
      rank: i + 1,
      ticker: r.ticker,
      name: text(r.s.signal.company_name),
      score: r.score,
      score_coverage: unit(r.s.signal.score_coverage),
      summary,
      evidence,
    };
  });

  const dedupe = (xs: (string | null | undefined)[]) =>
    [...new Set(xs.filter((x): x is string => !!x))].map((x) => x.slice(0, 500)).slice(0, 30);
  return {
    run_id: run.run_id,
    product,
    watchlist: run.watchlist_path || "default",
    status,
    scoring_version: run.scoring_version == null ? null : String(run.scoring_version),
    export_schema_version: EXPORT_SCHEMA_VERSION,
    as_of: run.as_of ?? run.started_at,
    started_at: run.started_at,
    completed_at: run.completed_at ?? null,
    limitations: dedupe([...(run.limitations ?? []), ...(parsed.data.limitations ?? [])]),
    warnings: dedupe(run.fetch_warnings ?? []),
    coverage: run.coverage ?? null,
    signal_count: signals.length,
    candidates,
  };
}

/** `uv` on a Mac (Homebrew or the installer's ~/.local/bin), else whatever is on PATH. */
export function findUv(env = process.env): string {
  if (env.TIDYSUM_MINER_UV) return env.TIDYSUM_MINER_UV;
  for (const p of [
    join(homedir(), ".local/bin/uv"),
    join(homedir(), ".cargo/bin/uv"),
    "/opt/homebrew/bin/uv",
    "/usr/local/bin/uv",
  ]) {
    if (existsSync(p)) return p;
  }
  return "uv";
}

/**
 * The miner's own CLI, run in its directory. `--no-sync` so reading never changes the miner's
 * environment; its scheduler service keeps that installed.
 */
export function cliMinerSource(dir: string, uv = findUv()): MinerSource {
  const run = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        uv,
        ["run", "--frozen", "--no-sync", "python", "-m", "investment_miner", ...args],
        {
          cwd: dir,
          timeout: 180_000,
          maxBuffer: 256 * 1024 * 1024,
          // Only what uv and Python need: none of Tidysum's secrets reach another program.
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: process.env.HOME ?? homedir(),
            LANG: "en_US.UTF-8",
          },
        },
        (err, stdout, stderr) => {
          if (err) {
            const detail = String(stderr || err.message)
              .trim()
              .split("\n")
              .slice(-3)
              .join(" ");
            reject(new Error(`investment_miner ${args[0]} failed: ${detail}`));
          } else resolve(stdout);
        },
      );
    });
  return {
    listRuns: async () => parseRunList(await run(["list-runs"])),
    exportRun: async (runId) => {
      if (!RUN_ID.test(runId)) throw new Error(`not a run id: ${runId}`);
      return JSON.parse(await run(["export", "--run", runId, "--format", "json"]));
    },
  };
}

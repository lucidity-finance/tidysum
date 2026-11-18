import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Product } from "./miner.js";

// Starting a fresh investment-miner scan from Tidysum. The miner's own API runs scans (and its
// weekday schedule) in one process that allows one scan per product at a time, so Tidysum asks
// it rather than starting a second copy of the pipeline. Its scoring is untouched; Tidysum only
// says "scan now" and imports the result when the scan finishes.

/** One scan job, as the miner's GET /api/jobs returns it. */
export interface MinerJob {
  job_id: string;
  job_type: string;
  status: string;
  run_id?: string | null;
  run_ids?: string[];
  started_at: string;
  completed_at?: string | null;
  error?: string | null;
  progress?: string;
  progress_pct?: number;
}

export interface MinerApi {
  /** Scans every watchlist of a product. Resolves to the job, or the one already running. */
  startScan(product: Product): Promise<MinerJob>;
  /** Recent jobs, newest first. Jobs live in the miner process, so a restart forgets them. */
  jobs(): Promise<MinerJob[]>;
}

/**
 * AUTH_PASSWORD from the miner's .env, read the way the miner reads it (first `KEY=value` wins,
 * value trimmed, nothing else unquoted); undefined when unset.
 */
export function readMinerPassword(dir: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, ".env"), "utf8");
  } catch {
    return undefined;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const at = line.indexOf("=");
    if (line.slice(0, at).trim() === "AUTH_PASSWORD") return line.slice(at + 1).trim() || undefined;
  }
  return undefined;
}

const isActive = (j: MinerJob) => j.status === "pending" || j.status === "running";

/** The miner's HTTP API on loopback, signing in with its password when it has one. */
export function httpMinerApi(
  baseUrl: string,
  password: () => string | undefined,
  fetchImpl: typeof fetch = fetch,
): MinerApi {
  let token: string | undefined;
  const call = async (path: string, init: RequestInit = {}, retry = true): Promise<Response> => {
    const pw = password();
    if (pw && !token) {
      const res = await fetchImpl(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`investment-miner refused the sign-in (${res.status})`);
      token = ((await res.json()) as { token?: string }).token || undefined;
    }
    const res = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 401 && retry) {
      token = undefined;
      return call(path, init, false);
    }
    return res;
  };
  const jobs = async () => {
    const res = await call("/api/jobs");
    if (!res.ok) throw new Error(`investment-miner jobs: ${res.status}`);
    return (await res.json()) as MinerJob[];
  };
  return {
    jobs,
    startScan: async (product) => {
      const res = await call("/api/scan-all", {
        method: "POST",
        body: JSON.stringify({ product }),
      });
      if (res.status === 409) {
        const running = (await jobs()).find((j) => j.job_type === product && isActive(j));
        if (running) return running;
      }
      if (!res.ok) {
        const detail = ((await res.json().catch(() => null)) as { detail?: string } | null)?.detail;
        throw new Error(`investment-miner wouldn't start a scan: ${detail ?? res.status}`);
      }
      const { job_id } = (await res.json()) as { job_id: string };
      const started = (await jobs()).find((j) => j.job_id === job_id);
      return (
        started ?? {
          job_id,
          job_type: product,
          status: "pending",
          started_at: new Date().toISOString(),
        }
      );
    },
  };
}

export type ScanStatus =
  | {
      state: "running";
      product: string;
      started_at: string;
      /** The miner's own progress line, such as "Scanning watchlist-ai-scaling.yaml (2/2)". */
      progress: string | null;
      pct: number | null;
    }
  | {
      state: "idle";
      /** The last scan the miner remembers, if any. */
      last: {
        product: string;
        status: string;
        completed_at: string | null;
        error: string | null;
      } | null;
    }
  | { state: "unavailable"; reason: string };

function summarize(jobs: MinerJob[]): ScanStatus {
  const running = jobs.find(isActive);
  if (running) {
    return {
      state: "running",
      product: running.job_type,
      started_at: running.started_at,
      progress: running.progress || null,
      pct: typeof running.progress_pct === "number" ? running.progress_pct : null,
    };
  }
  const last = jobs[0];
  return {
    state: "idle",
    last: last
      ? {
          product: last.job_type,
          status: last.status,
          completed_at: last.completed_at ?? null,
          error: last.error ?? null,
        }
      : null,
  };
}

/**
 * Starts scans and watches them: when the miner has no scan left running, Tidysum imports what
 * it produced. Scheduled scans are picked up the same way whenever someone looks at the status,
 * and by `tidysum serve`'s regular import otherwise.
 */
export class ResearchScanner {
  private watching = false;

  constructor(
    private readonly api: MinerApi,
    private readonly importNow: () => Promise<unknown>,
    private readonly pollMs = 15_000,
  ) {}

  /** Scans the institutional watchlists, the lists that rank what big funds hold. */
  async start(product: Product = "institutional"): Promise<ScanStatus> {
    await this.api.startScan(product);
    this.watch();
    return this.status();
  }

  async status(): Promise<ScanStatus> {
    let jobs: MinerJob[];
    try {
      jobs = await this.api.jobs();
    } catch (err) {
      return { state: "unavailable", reason: (err as Error).message };
    }
    const s = summarize(jobs);
    if (s.state === "running") this.watch();
    return s;
  }

  /** Resolves when no scan is running and the import after it is done. */
  async settled(): Promise<void> {
    while (this.watching) await new Promise((r) => setTimeout(r, Math.min(this.pollMs, 1_000)));
  }

  private watch() {
    if (this.watching) return;
    this.watching = true;
    const poll = async () => {
      let busy = true;
      try {
        busy = (await this.api.jobs()).some(isActive);
      } catch {
        // The miner restarting forgets its jobs; try again, then import whatever is there.
        busy = false;
      }
      if (busy) {
        setTimeout(poll, this.pollMs).unref?.();
        return;
      }
      try {
        await this.importNow();
      } catch (err) {
        console.error("research import after a scan failed:", err);
      } finally {
        this.watching = false;
      }
    };
    setTimeout(poll, this.pollMs).unref?.();
  }
}

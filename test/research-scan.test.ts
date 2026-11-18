import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  httpMinerApi,
  type MinerApi,
  type MinerJob,
  ResearchScanner,
  readMinerPassword,
} from "../src/research/scan.js";

describe("investment-miner scans", () => {
  it("reads the miner's password the way the miner does", async () => {
    const dir = await mkdtemp(join(tmpdir(), "miner-"));
    expect(readMinerPassword(dir)).toBeUndefined();
    await writeFile(join(dir, ".env"), "# AUTH_PASSWORD=old\nOTHER=1\n AUTH_PASSWORD = s3cret \n");
    expect(readMinerPassword(dir)).toBe("s3cret");
    await writeFile(join(dir, ".env"), "AUTH_PASSWORD=\n");
    expect(readMinerPassword(dir)).toBeUndefined();
  });

  it("signs in, starts a scan of every watchlist, and signs in again when the token expires", async () => {
    const calls: { path: string; auth: string | null; body: string | null }[] = [];
    let logins = 0;
    let expireOnce = true;
    const jobs: MinerJob[] = [];
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      calls.push({
        path: url.pathname,
        auth: headers.get("authorization"),
        body: (init?.body as string) ?? null,
      });
      const json = (v: unknown, status = 200) =>
        new Response(JSON.stringify(v), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.pathname === "/api/auth/login") {
        logins++;
        return JSON.parse(String(init?.body)).password === "pw"
          ? json({ token: `t${logins}` })
          : json({ detail: "Invalid password" }, 401);
      }
      if (headers.get("authorization") === "Bearer t1" && expireOnce) {
        expireOnce = false;
        return json({ detail: "Token expired" }, 401);
      }
      if (url.pathname === "/api/scan-all") {
        if (jobs.some((j) => j.status === "running")) {
          return json({ detail: "A institutional scan is already running" }, 409);
        }
        jobs.unshift({
          job_id: "j1",
          job_type: "institutional",
          status: "running",
          started_at: "2026-11-12T18:00:00Z",
          progress: "Scanning watchlist-institutional.yaml (1/2)",
          progress_pct: 10,
        });
        return json({ job_id: "j1", status: "pending" }, 202);
      }
      if (url.pathname === "/api/jobs") return json(jobs);
      return json({ detail: "not found" }, 404);
    }) as typeof fetch;

    const api = httpMinerApi("http://127.0.0.1:8000", () => "pw", fake);
    const job = await api.startScan("institutional");
    expect(job).toMatchObject({ job_id: "j1", status: "running" });
    expect(logins).toBe(2);
    expect(calls.find((c) => c.path === "/api/scan-all")?.body).toBe(
      JSON.stringify({ product: "institutional" }),
    );
    // A second press while it runs returns the running scan instead of an error.
    expect(await api.startScan("institutional")).toMatchObject({ job_id: "j1" });

    const refused = httpMinerApi("http://127.0.0.1:8000", () => "wrong", fake);
    await expect(refused.jobs()).rejects.toThrow(/refused the sign-in/);
  });

  it("reports progress and imports once the scan is done", async () => {
    const jobs: MinerJob[] = [];
    const api: MinerApi = {
      jobs: async () => jobs,
      startScan: async (product) => {
        const j: MinerJob = {
          job_id: "j1",
          job_type: product,
          status: "running",
          started_at: "2026-11-12T18:00:00Z",
          progress: "Scanning watchlist-ai-scaling.yaml (2/2)",
          progress_pct: 60,
        };
        jobs.unshift(j);
        return j;
      },
    };
    let imports = 0;
    const scanner = new ResearchScanner(
      api,
      async () => {
        imports++;
      },
      5,
    );
    expect(await scanner.status()).toEqual({ state: "idle", last: null });
    expect(await scanner.start()).toMatchObject({ state: "running", pct: 60 });
    await new Promise((r) => setTimeout(r, 30));
    expect(imports).toBe(0);
    Object.assign(jobs[0] as MinerJob, {
      status: "completed",
      completed_at: "2026-11-12T18:14:00Z",
    });
    await scanner.settled();
    expect(imports).toBe(1);
    expect(await scanner.status()).toEqual({
      state: "idle",
      last: {
        product: "institutional",
        status: "completed",
        completed_at: "2026-11-12T18:14:00Z",
        error: null,
      },
    });

    const down = new ResearchScanner(
      {
        jobs: async () => {
          throw new Error("fetch failed");
        },
        startScan: async () => {
          throw new Error("fetch failed");
        },
      },
      async () => {},
    );
    expect(await down.status()).toEqual({ state: "unavailable", reason: "fetch failed" });
  });
});

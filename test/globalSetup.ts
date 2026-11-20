import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";
import { connect, runMigrations } from "../src/db/client.js";
import { ensureLocalPostgres, stopLocalPostgres } from "../src/db/localPostgres.js";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const run = promisify(execFile);

interface TestPostgres {
  url: string;
  stop(): Promise<void>;
}

/**
 * Tests use a Testcontainers Postgres, locally and in CI. Where there is no Docker, set
 * TEST_PG=local for Tidysum's own Postgres, or TEST_PG_BIN (a PostgreSQL bin directory); either
 * way they run on a throwaway cluster in a temp directory, reachable only over a Unix socket.
 */
async function startPostgres(): Promise<TestPostgres> {
  if (process.env.TEST_PG === "local") {
    // Tidysum's own Postgres (decision 0012), in a temp directory: no Docker needed.
    const dir = await mkdtemp(join(tmpdir(), "tidysum-pg-"));
    return {
      url: await ensureLocalPostgres(dir),
      stop: async () => {
        await stopLocalPostgres(dir);
        await rm(dir, { recursive: true, force: true });
      },
    };
  }
  const bin = process.env.TEST_PG_BIN;
  if (!bin) {
    const container = await new PostgreSqlContainer("postgres:17").start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  }

  const dir = await mkdtemp(join(tmpdir(), "tidysum-pg-"));
  const data = join(dir, "data");
  const port = 5432;
  await run(join(bin, "initdb"), ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  await run(join(bin, "pg_ctl"), [
    "-D",
    data,
    "-l",
    join(dir, "postgres.log"),
    "-o",
    `-p ${port} -k ${dir} -c listen_addresses=''`,
    "-w",
    "start",
  ]);
  return {
    url: `postgresql://postgres@localhost:${port}/postgres?host=${encodeURIComponent(dir)}`,
    stop: async () => {
      await run(join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

let postgres: TestPostgres | undefined;

export async function setup(project: TestProject) {
  postgres = await startPostgres();
  const h = connect(postgres.url);
  await runMigrations(h.db);
  await h.close();
  project.provide("databaseUrl", postgres.url);
}

export async function teardown() {
  await postgres?.stop();
}

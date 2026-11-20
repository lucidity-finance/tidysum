import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import pg from "pg";

// Tidysum's own Postgres (decision 0012): a real PostgreSQL 17, from prebuilt binaries that come
// with the install, in a folder of its own. It is the same database the Docker setup runs, so the
// agent roles, their grants, row-level security and numeric money all hold unchanged. It listens
// on a Unix socket only, in a folder only its owner can open, and never on a network port.

const run = promisify(execFile);

/** The login role; it owns the database, as `tidysum` does in docker-compose.yml. */
const OWNER = "tidysum";
/** Only names the socket file (.s.PGSQL.5432): with no TCP listener it can't clash with anything. */
const PORT = 5432;

/** Where an installed Tidysum keeps everything: ~/.tidysum unless TIDYSUM_HOME says otherwise. */
export const tidysumHome = (env = process.env) =>
  resolve(env.TIDYSUM_HOME || join(homedir(), ".tidysum"));

/** The package that carries this platform's Postgres binaries (an optional dependency). */
export function binaryPackage(platform = process.platform, arch = process.arch): string {
  const supported = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
  const name = `${platform}-${arch}`;
  if (!supported.includes(name)) {
    throw new Error(
      `Tidysum has no built-in Postgres for ${name}. Set DATABASE_URL to a PostgreSQL 17 you run yourself, or TIDYSUM_PG_BIN to its bin folder.`,
    );
  }
  return `@embedded-postgres/${name}`;
}

/**
 * The packages ship their shared libraries' version links as a list, to be made after install.
 * pnpm doesn't run install scripts it wasn't told to trust, so make them here; it is idempotent.
 */
async function hydrateLinks(packageRoot: string): Promise<void> {
  let links: { source: string; target: string }[];
  try {
    links = JSON.parse(await readFile(join(packageRoot, "native", "pg-symlinks.json"), "utf8"));
  } catch {
    return;
  }
  for (const { source, target } of links) {
    const to = resolve(packageRoot, target);
    const from = resolve(packageRoot, source);
    await symlink(from.slice(dirname(to).length + 1), to).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") {
        throw new Error(`can't finish setting up Postgres in ${packageRoot}: ${err.message}`);
      }
    });
  }
}

/** The bin folder with initdb, pg_ctl and postgres. */
export async function postgresBin(env = process.env): Promise<string> {
  if (env.TIDYSUM_PG_BIN) return env.TIDYSUM_PG_BIN;
  const name = binaryPackage();
  let entry: string;
  try {
    entry = createRequire(import.meta.url).resolve(name);
  } catch {
    throw new Error(
      `${name} isn't installed. Reinstall Tidysum, or run \`pnpm install\` in its folder.`,
    );
  }
  const root = resolve(dirname(entry), "..");
  await hydrateLinks(root);
  return join(root, "native", "bin");
}

export interface LocalPostgresPaths {
  data: string;
  socket: string;
  log: string;
}

export const localPostgresPaths = (dir: string): LocalPostgresPaths => ({
  data: join(dir, "data"),
  socket: join(dir, "run"),
  log: join(dir, "postgres.log"),
});

/** A connection string for `database` over the cluster's socket. */
export function localPostgresUrl(dir: string, database = OWNER): string {
  const { socket } = localPostgresPaths(dir);
  return `postgres://${OWNER}@localhost/${database}?host=${encodeURIComponent(socket)}`;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const quoteConf = (s: string) => `'${s.replaceAll("'", "''")}'`;

/** Makes the cluster once. Two processes starting at the same moment can't both make it. */
async function initCluster(bin: string, p: LocalPostgresPaths): Promise<void> {
  if (await exists(join(p.data, "PG_VERSION"))) return;
  const parent = dirname(p.data);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const tmp = `${p.data}.init-${process.pid}-${randomBytes(4).toString("hex")}`;
  await rm(tmp, { recursive: true, force: true });
  await run(join(bin, "initdb"), [
    "-D",
    tmp,
    "-U",
    OWNER,
    "--auth=trust",
    "--encoding=UTF8",
    // Unicode-aware upper/lower and ILIKE for merchant names, the same on every machine.
    "--locale-provider=builtin",
    "--builtin-locale=C.UTF-8",
  ]);
  // Socket only. Trust is safe because only this user can open the socket's folder.
  await appendFile(
    join(tmp, "postgresql.conf"),
    [
      "",
      "# Tidysum: reachable only through the socket below, by this user.",
      "listen_addresses = ''",
      `unix_socket_directories = ${quoteConf(p.socket)}`,
      "unix_socket_permissions = 0700",
      `port = ${PORT}`,
      "",
    ].join("\n"),
  );
  try {
    await rename(tmp, p.data);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    // Another process made it first.
    if (!(await exists(join(p.data, "PG_VERSION")))) throw err;
  }
}

async function isRunning(bin: string, data: string): Promise<boolean> {
  try {
    await run(join(bin, "pg_ctl"), ["status", "-D", data]);
    return true;
  } catch {
    return false;
  }
}

async function tail(path: string, lines = 15): Promise<string> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

async function ensureDatabase(dir: string, database: string): Promise<void> {
  const client = new pg.Client({ connectionString: localPostgresUrl(dir, "postgres") });
  await client.connect();
  try {
    const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (found.rowCount === 0) {
      await client
        .query(`CREATE DATABASE "${database.replaceAll('"', '""')}" OWNER ${OWNER}`)
        .catch((err: { code?: string }) => {
          // Made by another process meanwhile (the catalog's unique index can answer first).
          if (err.code !== "42P04" && err.code !== "23505") throw err;
        });
    }
  } finally {
    await client.end();
  }
}

/**
 * Makes the cluster in `dir` if it isn't there, starts it if it isn't running, makes `database`
 * in it, and returns its connection string. Safe to call from every command.
 */
export async function ensureLocalPostgres(
  dir: string,
  opts: { database?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  if (process.platform === "win32") {
    throw new Error("Tidysum's own Postgres runs on macOS and Linux (on Windows, use WSL).");
  }
  if (process.getuid?.() === 0) {
    throw new Error(
      "Tidysum's own Postgres can't run as root (Postgres refuses). Run Tidysum as your normal user, or set DATABASE_URL.",
    );
  }
  const database = opts.database ?? OWNER;
  const bin = await postgresBin(opts.env);
  const p = localPostgresPaths(dir);
  await initCluster(bin, p);
  await mkdir(p.socket, { recursive: true, mode: 0o700 });
  if (!(await isRunning(bin, p.data))) {
    try {
      await run(join(bin, "pg_ctl"), ["start", "-w", "-t", "60", "-D", p.data, "-l", p.log]);
    } catch (err) {
      // Started by another process in the meantime is fine; anything else isn't.
      if (!(await isRunning(bin, p.data))) {
        throw new Error(
          `Tidysum's Postgres in ${p.data} didn't start (${(err as Error).message.split("\n")[0]}). Its log ends:\n${await tail(p.log)}`,
        );
      }
    }
  }
  await ensureDatabase(dir, database);
  return localPostgresUrl(dir, database);
}

/** Stops the cluster in `dir` if it runs. */
export async function stopLocalPostgres(dir: string, env = process.env): Promise<boolean> {
  const p = localPostgresPaths(dir);
  if (!(await exists(join(p.data, "PG_VERSION")))) return false;
  const bin = await postgresBin(env);
  if (!(await isRunning(bin, p.data))) return false;
  await run(join(bin, "pg_ctl"), ["stop", "-w", "-m", "fast", "-D", p.data]);
  return true;
}

/**
 * Asks the cluster in `dir` to stop without waiting, for a process on its way out: it can exit
 * before Postgres closes its connections, so they never fail under it.
 */
export async function stopLocalPostgresLater(dir: string, env = process.env): Promise<void> {
  const bin = await postgresBin(env);
  spawn(join(bin, "pg_ctl"), ["stop", "-m", "fast", "-D", localPostgresPaths(dir).data], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

/** Whether the cluster in `dir` is running. */
export async function localPostgresRunning(dir: string, env = process.env): Promise<boolean> {
  const p = localPostgresPaths(dir);
  if (!(await exists(join(p.data, "PG_VERSION")))) return false;
  return isRunning(await postgresBin(env), p.data);
}

import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { localPostgresRunning, stopLocalPostgres } from "./db/localPostgres.js";

// `tidysum start | stop | restart | status | logs` for an installed Tidysum (decision 0012):
// `tidysum serve` as a background service of the user's own, a launchd agent on a Mac and a
// systemd user service on Linux, so it starts at login and comes back if it exits. Where neither
// is available (WSL without systemd, a container) it runs as a plain background process.
//
// A checkout run with deploy/macos-setup.sh has its own agent (com.tidysum.serve); this one has a
// different name, so the two never replace each other.

export const LAUNCHD_LABEL = "com.tidysum.app";
export const SYSTEMD_UNIT = "tidysum.service";

export interface ServiceContext {
  /** TIDYSUM_HOME: the install's own folder (~/.tidysum). */
  home: string;
  /** The `tidysum` command install.sh wrote, which the service runs as `<launcher> serve`. */
  launcher: string;
  /** The user's home folder, where launchd and systemd look for user services. */
  userHome: string;
  platform: NodeJS.Platform;
}

export const serviceContext = (env = process.env): ServiceContext => {
  const home = env.TIDYSUM_HOME;
  const launcher = env.TIDYSUM_LAUNCHER;
  if (!home || !launcher) {
    throw new Error(
      "start, stop, status and logs are for Tidysum installed with install.sh. In a git checkout, run `pnpm tidysum serve`, or deploy/macos-setup.sh on a Mac.",
    );
  }
  return { home, launcher, userHome: homedir(), platform: process.platform };
};

export const logFile = (ctx: Pick<ServiceContext, "home">) => join(ctx.home, "logs", "serve.log");
const pidFile = (ctx: ServiceContext) => join(ctx.home, "run", "serve.pid");
const plistPath = (ctx: ServiceContext) =>
  join(ctx.userHome, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const unitPath = (ctx: ServiceContext) =>
  join(ctx.userHome, ".config", "systemd", "user", SYSTEMD_UNIT);

const xml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The launchd agent: runs `tidysum serve` at login and again whenever it exits. */
export function launchdPlist(ctx: ServiceContext): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(ctx.launcher)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TIDYSUM_HOME</key><string>${xml(ctx.home)}</string>
  </dict>
  <key>WorkingDirectory</key><string>${xml(ctx.home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <!-- Postgres runs on in its own session when serve restarts; tidysum stop stops it. -->
  <key>AbandonProcessGroup</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(logFile(ctx))}</string>
  <key>StandardErrorPath</key><string>${xml(logFile(ctx))}</string>
</dict>
</plist>
`;
}

/** systemd quotes: a path with spaces or quotes stays one argument. */
const sd = (s: string) => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** The systemd user service: the same, for Linux. */
export function systemdUnit(ctx: ServiceContext): string {
  return `[Unit]
Description=Tidysum (your money hub, on this computer)

[Service]
ExecStart=${sd(ctx.launcher)} serve
Environment=${sd(`TIDYSUM_HOME=${ctx.home}`)}
WorkingDirectory=${ctx.home}
Restart=always
RestartSec=10
# Postgres runs on in its own session when serve restarts; tidysum stop stops it.
KillMode=process
StandardOutput=append:${logFile(ctx)}
StandardError=append:${logFile(ctx)}

[Install]
WantedBy=default.target
`;
}

type Runner = (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>;

const runCommand: Runner = async (cmd, args) => {
  try {
    const { stdout } = await promisify(execFile)(cmd, args);
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, stdout: String((err as { stdout?: string }).stdout ?? "") };
  }
};

type Manager = "launchd" | "systemd" | "process";

async function manager(ctx: ServiceContext, run: Runner): Promise<Manager> {
  if (ctx.platform === "darwin") return "launchd";
  if (ctx.platform === "linux" && (await run("systemctl", ["--user", "show-environment"])).ok) {
    return "systemd";
  }
  return "process";
}

const launchdDomain = () => `gui/${process.getuid?.() ?? 0}`;

async function processPid(ctx: ServiceContext): Promise<number | undefined> {
  const pid = Number((await readFile(pidFile(ctx), "utf8").catch(() => "")).trim());
  if (!pid) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

/** Whether the service runs, as its manager sees it, or as a plain background process. */
async function serviceRunning(ctx: ServiceContext, m: Manager, run: Runner): Promise<boolean> {
  if ((await processPid(ctx)) !== undefined) return true;
  if (m === "launchd")
    return (await run("launchctl", ["print", `${launchdDomain()}/${LAUNCHD_LABEL}`])).ok;
  if (m === "systemd")
    return (await run("systemctl", ["--user", "is-active", "--quiet", SYSTEMD_UNIT])).ok;
  return false;
}

/** Starts the service; returns how it runs, which is a plain process if its manager refused it. */
async function startService(ctx: ServiceContext, m: Manager, run: Runner): Promise<Manager> {
  await mkdir(join(ctx.home, "logs"), { recursive: true });
  if (m === "launchd") {
    await mkdir(join(ctx.userHome, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath(ctx), launchdPlist(ctx));
    const target = `${launchdDomain()}/${LAUNCHD_LABEL}`;
    if ((await run("launchctl", ["print", target])).ok) {
      if ((await run("launchctl", ["kickstart", "-k", target])).ok) return m;
    } else {
      // A bootout that hasn't finished makes bootstrap fail with an I/O error; try a few times.
      for (let attempt = 1; attempt <= 5; attempt++) {
        if ((await run("launchctl", ["bootstrap", launchdDomain(), plistPath(ctx)])).ok) return m;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    // No login session to load it into (over ssh, say): run it as a plain process this time.
    await rm(plistPath(ctx), { force: true });
    console.warn(
      `launchd wouldn't load ${LAUNCHD_LABEL}; running Tidysum as a background process.`,
    );
  }
  if (m === "systemd") {
    await mkdir(join(ctx.userHome, ".config", "systemd", "user"), { recursive: true });
    await writeFile(unitPath(ctx), systemdUnit(ctx));
    await run("systemctl", ["--user", "daemon-reload"]);
    if (
      (await run("systemctl", ["--user", "enable", SYSTEMD_UNIT])).ok &&
      (await run("systemctl", ["--user", "restart", SYSTEMD_UNIT])).ok
    ) {
      return m;
    }
    await rm(unitPath(ctx), { force: true });
    console.warn(
      `systemd wouldn't start ${SYSTEMD_UNIT}; running Tidysum as a background process.`,
    );
  }
  if (await processPid(ctx)) return "process";
  await mkdir(join(ctx.home, "run"), { recursive: true });
  const out = openSync(logFile(ctx), "a");
  const child = spawn(ctx.launcher, ["serve"], {
    cwd: ctx.home,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, TIDYSUM_HOME: ctx.home },
  });
  closeSync(out);
  child.unref();
  await writeFile(pidFile(ctx), `${child.pid}\n`);
  return "process";
}

async function stopService(ctx: ServiceContext, m: Manager, run: Runner): Promise<void> {
  if (m === "launchd") await run("launchctl", ["bootout", `${launchdDomain()}/${LAUNCHD_LABEL}`]);
  if (m === "systemd") await run("systemctl", ["--user", "stop", SYSTEMD_UNIT]);
  const pid = await processPid(ctx);
  if (pid) {
    process.kill(pid, "SIGTERM");
    // Wait for it, so a start right after doesn't find the old page still answering.
    for (let i = 0; i < 40 && (await processPid(ctx)); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  await rm(pidFile(ctx), { force: true });
}

const postgresDir = (ctx: ServiceContext) => join(ctx.home, "postgres");

export interface StartOptions {
  url: string;
  open?: boolean;
  run?: Runner;
  waitMs?: number;
}

async function healthy(url: string): Promise<boolean> {
  try {
    return (await fetch(new URL("/healthz", url), { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

/** Starts (or restarts) the service and waits until the page answers. */
export async function start(ctx: ServiceContext, opts: StartOptions): Promise<string[]> {
  const run = opts.run ?? runCommand;
  const m = await startService(ctx, await manager(ctx, run), run);
  const deadline = Date.now() + (opts.waitMs ?? 90_000);
  while (!(await healthy(opts.url))) {
    if (Date.now() > deadline) {
      const log = (await readFile(logFile(ctx), "utf8").catch(() => "")).trimEnd();
      throw new Error(
        `Tidysum didn't answer at ${opts.url} yet. The end of ${logFile(ctx)}:\n${log.split("\n").slice(-15).join("\n")}`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const out = [`Tidysum is running: ${opts.url}`];
  if (m === "process") {
    out.push("(It runs until you log out or restart; run `tidysum start` again after that.)");
  }
  if (opts.open) await openBrowser(opts.url, ctx.platform, run);
  return out;
}

/**
 * Stops the page and Tidysum's own Postgres, and keeps them stopped across logins until
 * `tidysum start`. Your data stays where it is.
 */
export async function stop(ctx: ServiceContext, run: Runner = runCommand): Promise<string[]> {
  const m = await manager(ctx, run);
  await stopService(ctx, m, run);
  if (m === "launchd") await rm(plistPath(ctx), { force: true });
  if (m === "systemd") {
    await run("systemctl", ["--user", "disable", SYSTEMD_UNIT]);
    await rm(unitPath(ctx), { force: true });
    await run("systemctl", ["--user", "daemon-reload"]);
  }
  const pg = await stopLocalPostgres(postgresDir(ctx)).catch(() => false);
  return [`Tidysum stopped${pg ? " (and its database)" : ""}. \`tidysum start\` starts it again.`];
}

export async function status(
  ctx: ServiceContext,
  url: string,
  run: Runner = runCommand,
): Promise<{ lines: string[]; database: boolean }> {
  const m = await manager(ctx, run);
  const version = (
    await readFile(join(ctx.home, "app", "current", ".commit"), "utf8").catch(() => "")
  )
    .trim()
    .slice(0, 12);
  const [service, page, db] = await Promise.all([
    serviceRunning(ctx, m, run),
    healthy(url),
    localPostgresRunning(postgresDir(ctx)).catch(() => false),
  ]);
  const lines = [
    `Tidysum ${version || "(version unknown)"} in ${ctx.home}`,
    `  page:      ${page ? `running at ${url}` : service ? "starting (or failing: tidysum logs)" : "stopped"}`,
    `  database:  ${db ? "running" : "stopped"}`,
    `  service:   ${m === "launchd" ? `launchd agent ${LAUNCHD_LABEL}` : m === "systemd" ? `systemd user service ${SYSTEMD_UNIT}` : "background process"}, ${service ? "on" : "off"}`,
    `  logs:      ${logFile(ctx)}`,
  ];
  return { lines, database: db };
}

export async function openBrowser(
  url: string,
  platform: NodeJS.Platform,
  run: Runner = runCommand,
) {
  if (platform === "darwin") return void (await run("open", [url]));
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) await run("xdg-open", [url]);
}

/** `tidysum logs`: the last lines of the log, and with -f, everything after them as it comes. */
export function followLogs(ctx: ServiceContext, follow: boolean): Promise<void> {
  const args = ["-n", "100", ...(follow ? ["-F"] : []), logFile(ctx)];
  return new Promise((resolve) => {
    spawn("tail", args, { stdio: "inherit" }).on("exit", () => resolve());
  });
}

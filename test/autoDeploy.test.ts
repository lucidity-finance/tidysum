import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// deploy/auto-deploy.sh runs unattended on the owner's Mac, so drive it against throwaway git
// repos: a bare "GitHub", a dev clone that merges, and the "Mac" clone it deploys.
const run = promisify(execFile);
const SCRIPT = resolve("deploy/auto-deploy.sh");

let root: string;
let mac: string;
let dev: string;
let healthUrl: string;
let server: Server;

const calls = () => join(root, "setup-calls");
const notices = () => join(root, "notices");
const readLines = (path: string) =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
const status = () =>
  Object.fromEntries(
    readLines(join(mac, ".deploy/status")).map((l) => [
      l.slice(0, l.indexOf("=")),
      l.slice(l.indexOf("=") + 1),
    ]),
  );

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
}

async function commit(file: string, content: string, message: string): Promise<string> {
  writeFileSync(join(dev, file), content);
  await git(dev, "add", "-A");
  await git(dev, "commit", "-q", "-m", message);
  await git(dev, "push", "-q", "origin", "main");
  return git(dev, "rev-parse", "HEAD");
}

async function autoDeploy(env: Record<string, string> = {}) {
  return run("bash", [SCRIPT], {
    env: {
      ...process.env,
      TIDYSUM_REPO: mac,
      TIDYSUM_SETUP: join(root, "setup.sh"),
      TIDYSUM_NOTIFY: join(root, "notify.sh"),
      TIDYSUM_READY_CHECK: "true",
      TIDYSUM_HEALTH_URL: healthUrl,
      TIDYSUM_HEALTH_TRIES: "1",
      CALLS: calls(),
      ...env,
    },
  });
}

beforeAll(async () => {
  server = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  healthUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz`;
});
afterAll(() => {
  server.close();
});

beforeEach(async () => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = mkdtempSync(join(tmpdir(), "auto-deploy-"));
  // A deploy "fails" while the repo has a file named broken, like a migration that won't apply.
  writeFileSync(
    join(root, "setup.sh"),
    '[[ -f broken ]] && exit 1\ngit rev-parse HEAD >> "$CALLS"\n',
  );
  writeFileSync(join(root, "notify.sh"), `echo "$1" >> ${notices()}\n`, { mode: 0o755 });
  const origin = join(root, "origin.git");
  await run("git", ["init", "-q", "--bare", "-b", "main", origin]);
  dev = join(root, "dev");
  await run("git", ["clone", "-q", origin, dev]);
  await git(dev, "config", "user.email", "dev@example.com");
  await git(dev, "config", "user.name", "dev");
  await git(dev, "checkout", "-q", "-b", "main");
  const first = await commit("app.txt", "v1", "first");
  mac = join(root, "mac");
  await run("git", ["clone", "-q", origin, mac]);
  await run("mkdir", ["-p", join(mac, ".deploy")]);
  writeFileSync(join(mac, ".deploy/deployed"), `${first}\n`);
});

describe("auto-deploy", () => {
  it("does nothing while main is already deployed", async () => {
    await autoDeploy();
    expect(readLines(calls())).toEqual([]);
    expect(existsSync(join(mac, ".deploy/status"))).toBe(false);
  });

  it("deploys a new commit on main once, then waits for the next", async () => {
    const second = await commit("app.txt", "v2", "second");
    await autoDeploy();
    expect(await git(mac, "rev-parse", "HEAD")).toBe(second);
    expect(readLines(calls())).toEqual([second]);
    expect(status()).toMatchObject({ result: "ok", commit: second, message: "deployed: second" });
    await autoDeploy();
    expect(readLines(calls())).toEqual([second]);
    expect(readLines(notices())).toEqual([]);
  });

  it("rolls a failed deploy back, retries twice, tells the owner once, then deploys the fix", async () => {
    const good = await git(dev, "rev-parse", "HEAD");
    const bad = await commit("broken", "", "bad migration");
    await autoDeploy();
    expect(await git(mac, "rev-parse", "HEAD")).toBe(good);
    expect(readLines(calls())).toEqual([good]);
    expect(status().result).toBe("failed");
    expect(status().message).toContain("rolled back");
    expect(readLines(notices())).toEqual([]);

    await autoDeploy();
    await autoDeploy();
    await autoDeploy();
    expect(readLines(calls())).toEqual([good, good, good]);
    expect(readLines(notices())).toHaveLength(1);
    expect(readLines(notices())[0]).toContain("Deploy failed: bad migration");
    expect(status().commit).toBe(bad);

    await git(dev, "rm", "-q", "broken");
    const fix = await commit("app.txt", "v3", "fix migration");
    await autoDeploy();
    expect(await git(mac, "rev-parse", "HEAD")).toBe(fix);
    expect(status()).toMatchObject({ result: "ok", commit: fix });
    expect(readLines(notices())[1]).toBe("Deploys are working again: fix migration");
  });

  it("leaves a clone with local edits alone and says so once", async () => {
    writeFileSync(join(mac, "app.txt"), "edited on the Mac");
    await commit("other.txt", "x", "second");
    await autoDeploy();
    await autoDeploy();
    expect(readLines(calls())).toEqual([]);
    expect(readFileSync(join(mac, "app.txt"), "utf8")).toBe("edited on the Mac");
    expect(status()).toMatchObject({ result: "skipped" });
    expect(readLines(notices())).toEqual([
      "Not deploying second: files in your Tidysum folder have local edits.",
    ]);
  });

  it("doesn't deploy a clone that's on another branch", async () => {
    await git(mac, "checkout", "-q", "-b", "experiment");
    await commit("app.txt", "v2", "second");
    await autoDeploy();
    expect(readLines(calls())).toEqual([]);
    expect(status().message).toBe("the clone is on experiment, not main");
  });

  it("waits for Docker without spending a retry", async () => {
    const second = await commit("app.txt", "v2", "second");
    for (let i = 0; i < 5; i++) await autoDeploy({ TIDYSUM_READY_CHECK: "false" });
    expect(readLines(calls())).toEqual([]);
    expect(readLines(notices())).toEqual([
      "Not deploying second yet: Docker Desktop isn't running.",
    ]);
    await autoDeploy();
    expect(readLines(calls())).toEqual([second]);
  });
});

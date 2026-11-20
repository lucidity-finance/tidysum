import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  binaryPackage,
  ensureLocalPostgres,
  localPostgresUrl,
  stopLocalPostgres,
} from "../src/db/localPostgres.js";
import { launchdPlist, type ServiceContext, systemdUnit } from "../src/service.js";

const ctx: ServiceContext = {
  home: "/Users/Jane Doe/.tidysum",
  launcher: "/Users/Jane Doe/.tidysum/bin/tidysum",
  userHome: "/Users/Jane Doe",
  platform: "darwin",
};

describe("background service", () => {
  it("runs `tidysum serve` from the install's folder at login and after it exits (launchd)", () => {
    const plist = launchdPlist(ctx);
    expect(plist).toContain(
      "<string>/Users/Jane Doe/.tidysum/bin/tidysum</string>\n    <string>serve</string>",
    );
    expect(plist).toContain("<key>WorkingDirectory</key><string>/Users/Jane Doe/.tidysum</string>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("/Users/Jane Doe/.tidysum/logs/serve.log");
    // Not the checkout's agent (deploy/macos-setup.sh), so neither replaces the other.
    expect(plist).toContain("<string>com.tidysum.app</string>");
    expect(launchdPlist({ ...ctx, home: "/a&b" })).toContain("/a&amp;b");
  });

  it("does the same with a systemd user service, quoting paths with spaces", () => {
    const unit = systemdUnit({ ...ctx, platform: "linux" });
    expect(unit).toContain('ExecStart="/Users/Jane Doe/.tidysum/bin/tidysum" serve');
    expect(unit).toContain('Environment="TIDYSUM_HOME=/Users/Jane Doe/.tidysum"');
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
  });
});

describe("Tidysum's own Postgres", () => {
  it("has binaries for Macs and Linux, and says what to do elsewhere", () => {
    expect(binaryPackage("darwin", "arm64")).toBe("@embedded-postgres/darwin-arm64");
    expect(binaryPackage("linux", "x64")).toBe("@embedded-postgres/linux-x64");
    expect(() => binaryPackage("win32", "x64")).toThrow(/DATABASE_URL/);
  });

  it("connects over a socket in a folder of its own, never a network port", () => {
    expect(localPostgresUrl("/home/j/.tidysum/postgres")).toBe(
      "postgres://tidysum@localhost/tidysum?host=%2Fhome%2Fj%2F.tidysum%2Fpostgres%2Frun",
    );
  });

  // Postgres refuses to run as root, so this runs wherever tests run as a normal user (CI does).
  it.skipIf(process.getuid?.() === 0)(
    "makes, starts and reuses one cluster, even when asked twice at once",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "tidysum-local-pg-"));
      try {
        const [a, b] = await Promise.all([ensureLocalPostgres(dir), ensureLocalPostgres(dir)]);
        expect(a).toBe(b);
        expect(await ensureLocalPostgres(dir)).toBe(a);
        expect((await stat(join(dir, "run"))).mode & 0o777).toBe(0o700);
        const conf = await readFile(join(dir, "data", "postgresql.conf"), "utf8");
        expect(conf).toContain("listen_addresses = ''");
        const client = new pg.Client({ connectionString: a });
        await client.connect();
        const { rows } = await client.query(
          "select current_setting('server_version_num')::int / 10000 as major, lower('ÉCOLE') as l",
        );
        await client.end();
        expect(rows[0]).toEqual({ major: 17, l: "école" });
        expect(await stopLocalPostgres(dir)).toBe(true);
        expect(await stopLocalPostgres(dir)).toBe(false);
      } finally {
        await stopLocalPostgres(dir).catch(() => {});
        await rm(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe("install.sh", () => {
  it("is plain POSIX sh that runs only once it has all arrived", async () => {
    await promisify(execFile)("sh", ["-n", "install.sh"]);
    const script = await readFile("install.sh", "utf8");
    expect(script.trimEnd().endsWith('main "$@"')).toBe(true);
    // A pinned, checksummed Node.js for each platform the Postgres binaries cover.
    for (const p of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
      expect(script).toMatch(new RegExp(`${p}\\) echo [0-9a-f]{64} ;;`));
    }
  });
});

import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentRules,
  installedRules,
  mergeAllow,
  type Run,
  repoRoot,
  setupAgent,
} from "../src/agentSetup.js";

const REPO = "/opt/tidysum";
const homes: string[] = [];
const newHome = async () => {
  const h = await mkdtemp(join(tmpdir(), "tidysum-home-"));
  homes.push(h);
  return h;
};
afterEach(async () => {
  for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true });
});

/** A fake `claude` CLI: records calls; `mcp get` fails until `mcp add` ran. */
function fakeClaude(installed = true) {
  const calls: string[] = [];
  let added = false;
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (!installed) return { ok: false };
    if (args[0] === "mcp" && args[1] === "get") return { ok: added };
    if (args[0] === "mcp" && args[1] === "add") added = true;
    return { ok: true };
  };
  return { run, calls };
}

describe("agent setup", () => {
  it("allows only Tidysum's MCP tools and its command line in this repo", () => {
    expect(agentRules(REPO)).toEqual(["Bash(pnpm -C /opt/tidysum -s tidysum:*)", "mcp__tidysum"]);
    expect(repoRoot()).not.toMatch(/\/$/);
  });

  it("adds the rules and keeps every other setting", () => {
    const { settings, added } = mergeAllow(
      { model: "x", permissions: { allow: ["Bash(ls)", "mcp__tidysum"], deny: ["Bash(rm:*)"] } },
      agentRules(REPO),
    );
    expect(added).toEqual(["Bash(pnpm -C /opt/tidysum -s tidysum:*)"]);
    expect(settings).toEqual({
      model: "x",
      permissions: {
        allow: ["Bash(ls)", "mcp__tidysum", "Bash(pnpm -C /opt/tidysum -s tidysum:*)"],
        deny: ["Bash(rm:*)"],
      },
    });
    expect(() => mergeAllow({ permissions: { allow: "all" } }, [])).toThrow(/list of rules/);
    expect(() => mergeAllow([], [])).toThrow(/JSON object/);
  });

  it("sets up permissions, the skill and the MCP server once, and again changes nothing", async () => {
    const home = await newHome();
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), '{"theme":"dark"}');
    const claude = fakeClaude();

    const first = await setupAgent({ repo: REPO, home, run: claude.run });
    expect(first[0]).toMatch(/^Permissions: allowed /);
    expect(first[1]).toMatch(/^Skill: linked /);
    expect(first[2]).toBe("MCP server: added tidysum for your user");
    const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
    expect(settings).toEqual({ theme: "dark", permissions: { allow: agentRules(REPO) } });
    const link = join(home, ".claude", "skills", "tidysum-actions");
    expect(await readlink(link)).toBe("/opt/tidysum/skills/tidysum-actions");
    expect(claude.calls).toContain(
      "claude mcp add --scope user tidysum -- pnpm -s --dir /opt/tidysum tidysum mcp",
    );

    const again = await setupAgent({ repo: REPO, home, run: claude.run });
    expect(again).toEqual([
      `Permissions: already allowed in ${join(home, ".claude", "settings.json")}`,
      `Skill: already linked at ${link}`,
      "MCP server: tidysum is already added",
    ]);
  });

  it("points an installed Tidysum's agent at the tidysum command and the current version's skill", async () => {
    const home = await newHome();
    const installed = { home: "/u/.tidysum", launcher: "/u/.tidysum/bin/tidysum" };
    const claude = fakeClaude();
    await setupAgent({ installed, home, run: claude.run });
    const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.permissions.allow).toEqual([
      "Bash(tidysum:*)",
      "Bash(/u/.tidysum/bin/tidysum:*)",
      "mcp__tidysum",
    ]);
    expect(installedRules(installed)).toEqual(settings.permissions.allow);
    expect(await readlink(join(home, ".claude", "skills", "tidysum-actions"))).toBe(
      "/u/.tidysum/app/current/skills/tidysum-actions",
    );
    expect(claude.calls).toContain(
      "claude mcp add --scope user tidysum -- /u/.tidysum/bin/tidysum mcp",
    );
  });

  it("changes nothing on a dry run and says how to add the server without claude", async () => {
    const home = await newHome();
    const out = await setupAgent({ repo: REPO, home, run: fakeClaude(false).run, dryRun: true });
    expect(out[0]).toBe("Dry run, nothing changed:");
    expect(out[3]).toMatch(/claude mcp add --scope user tidysum -- pnpm -s --dir \/opt\/tidysum/);
    expect(await lstat(join(home, ".claude")).catch(() => null)).toBeNull();
  });

  it("refuses a settings file it can't read rather than overwrite it", async () => {
    const home = await newHome();
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), "{ not json");
    await expect(setupAgent({ repo: REPO, home, run: fakeClaude().run })).rejects.toThrow(
      /Can't read/,
    );
    expect(await readFile(join(home, ".claude", "settings.json"), "utf8")).toBe("{ not json");
  });
});

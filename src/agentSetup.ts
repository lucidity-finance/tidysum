import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// One command that connects the owner's own Claude Code to Tidysum (decision 0005: bring your own
// agent), so it works out of the box: the MCP server, the skill that carries out approved
// actions, and permission to use both without the agent being stopped at every step. Claude Code
// won't grant itself permissions, so the owner runs this once, in their own terminal.
//
// The permissions cover Tidysum's own MCP tools and its command line in this repo. Neither can
// move money: approving an action stays on the Actions page, and trades wait for the owner.

export const SKILL = "tidysum-actions";

/** The repo this file lives in. */
export const repoRoot = () => fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/** The permission rules for an agent working with the Tidysum repo at `repo`. */
export function agentRules(repo: string): string[] {
  return [`Bash(pnpm -C ${repo} -s tidysum:*)`, "mcp__tidysum"];
}

/**
 * Tidysum installed with install.sh (decision 0012): the `tidysum` command, by name and by its
 * full path for a shell that doesn't have ~/.local/bin on PATH.
 */
export interface Installed {
  /** TIDYSUM_HOME, e.g. ~/.tidysum. */
  home: string;
  /** The `tidysum` command install.sh wrote. */
  launcher: string;
}

/** The permission rules for an agent working with an installed Tidysum. */
export function installedRules(i: Installed): string[] {
  return ["Bash(tidysum:*)", `Bash(${i.launcher}:*)`, "mcp__tidysum"];
}

/** The installed Tidysum this command runs from, if it does (the launcher sets both). */
export function installedFromEnv(env = process.env): Installed | undefined {
  return env.TIDYSUM_HOME && env.TIDYSUM_LAUNCHER
    ? { home: env.TIDYSUM_HOME, launcher: env.TIDYSUM_LAUNCHER }
    : undefined;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Adds `rules` to a Claude Code settings object's permissions.allow, keeping everything else as
 * it is. Throws when the settings aren't shaped the way Claude Code reads them.
 */
export function mergeAllow(
  settings: unknown,
  rules: string[],
): { settings: Json; added: string[] } {
  if (!isObject(settings)) throw new Error("the settings file isn't a JSON object");
  const permissions = settings.permissions ?? {};
  if (!isObject(permissions)) throw new Error("permissions in the settings file isn't an object");
  const allow = permissions.allow ?? [];
  if (!Array.isArray(allow) || !allow.every((r) => typeof r === "string")) {
    throw new Error("permissions.allow in the settings file isn't a list of rules");
  }
  const added = rules.filter((r) => !allow.includes(r));
  return {
    settings: { ...settings, permissions: { ...permissions, allow: [...allow, ...added] } },
    added,
  };
}

export type Run = (cmd: string, args: string[]) => Promise<{ ok: boolean }>;

const runCommand: Run = async (cmd, args) => {
  try {
    await promisify(execFile)(cmd, args);
    return { ok: true };
  } catch {
    return { ok: false };
  }
};

export interface SetupOptions {
  /** A git checkout; the default when this isn't an installed Tidysum. */
  repo?: string;
  /** An installed Tidysum; the default when the `tidysum` command started this. */
  installed?: Installed;
  home?: string;
  dryRun?: boolean;
  run?: Run;
}

/** What setup did (or, on a dry run, would do), one line per step. */
export async function setupAgent(opts: SetupOptions = {}): Promise<string[]> {
  const installed = opts.repo ? undefined : (opts.installed ?? installedFromEnv());
  const repo = opts.repo ?? repoRoot();
  // The MCP server's command, and where the skill lives. An install's `app/current` moves to the
  // new version on upgrade, so the skill link follows it.
  const mcpCommand = installed
    ? [installed.launcher, "mcp"]
    : ["pnpm", "-s", "--dir", repo, "tidysum", "mcp"];
  const skillsDir = installed
    ? join(installed.home, "app", "current", "skills")
    : join(repo, "skills");
  const home = opts.home ?? homedir();
  const run = opts.run ?? runCommand;
  const dry = opts.dryRun ?? false;
  const out: string[] = [];

  // 1. Permissions, in the user's settings so they hold in any folder the agent starts in.
  const file = join(home, ".claude", "settings.json");
  let current: unknown = {};
  try {
    current = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Can't read ${file}: ${(e as Error).message}. Fix it, then run this again.`);
    }
  }
  const { settings, added } = mergeAllow(
    current,
    installed ? installedRules(installed) : agentRules(repo),
  );
  if (added.length === 0) {
    out.push(`Permissions: already allowed in ${file}`);
  } else {
    if (!dry) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
    }
    out.push(`Permissions: allowed ${added.join(", ")} in ${file}`);
  }

  // 2. The skill, linked rather than copied so a pull updates it.
  const link = join(home, ".claude", "skills", SKILL);
  const target = join(skillsDir, SKILL);
  const existing = await lstat(link).catch(() => null);
  if (!existing) {
    if (!dry) {
      await mkdir(dirname(link), { recursive: true });
      await symlink(target, link);
    }
    out.push(`Skill: linked ${link} to ${target}`);
  } else if (existing.isSymbolicLink() && (await readlink(link)) === target) {
    out.push(`Skill: already linked at ${link}`);
  } else {
    out.push(`Skill: left ${link} as it is (it isn't a link to ${target}; remove it to relink)`);
  }

  // 3. The MCP server, for the user so every folder has it.
  if (!(await run("claude", ["--version"])).ok) {
    out.push(
      `MCP server: Claude Code's \`claude\` command isn't on PATH; add it later with: claude mcp add --scope user tidysum -- ${mcpCommand.join(" ")}`,
    );
  } else if ((await run("claude", ["mcp", "get", "tidysum"])).ok) {
    out.push("MCP server: tidysum is already added");
  } else {
    const args = ["mcp", "add", "--scope", "user", "tidysum", "--", ...mcpCommand];
    const added = dry || (await run("claude", args)).ok;
    out.push(
      added
        ? "MCP server: added tidysum for your user"
        : `MCP server: adding it failed; try: claude ${args.join(" ")}`,
    );
  }
  if (dry) out.unshift("Dry run, nothing changed:");
  return out;
}

# 0012: Installing takes one step

Date: 2026-11-20
Status: accepted (the owner: "we should implement this: Installing takes one step, even if it
means rearchitecting something. obviously considering tradeoffs")

## Context

Until now, running Tidysum meant installing Node 22.19 or newer, pnpm and Docker, cloning the
repository, starting Postgres with `docker compose`, copying `.env.example`, generating a key and
running two commands. Each prerequisite loses people: Docker Desktop alone is a large download, needs
a licence at larger companies, and has to be running. The closest open-source alternative ships a
one-line installer and desktop apps.

What must not change on the way:

- **Real Postgres.** Agents read through `tidysum_agent` and propose through `tidysum_proposer`,
  two roles with explicit grants and row-level security, chosen per connection as startup
  parameters (`src/mcp/agentDb.ts`, guide "Design rules that already hold"). Money is `numeric`.
  The MCP stdio server (started by the agent) and `tidysum serve` are separate processes using the
  same database at the same time.
- **Bring your own agent works out of the box**: `tidysum agent setup` and `tidysum mcp`.
- **The owner's Mac** keeps running from its git clone, with Docker Postgres, launchd and
  auto-deploy (`deploy/macos-setup.sh`, `deploy/auto-deploy.sh`).

## Options

| Option                                                        | For                                                                                                                                      | Against                                                                                                                                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One-line installer with its own Node and its own Postgres** | No prerequisites but `curl`; real Postgres, so roles, RLS and `numeric` hold as they are; everything in one folder; nothing runs as root | `curl \| sh` asks for trust; about 500 MB on disk; Postgres binaries come from a third-party build                                                                                                                    |
| PGlite (Postgres in WebAssembly)                              | One npm package, no binaries                                                                                                             | One connection at a time in one process, so `tidysum mcp` and `serve` can't share it; roles and per-connection startup parameters would need re-architecting; the security boundary would move into application code  |
| `docker compose` one-liner                                    | Already half there                                                                                                                       | Docker remains the prerequisite this is meant to remove                                                                                                                                                               |
| Single binary (Node SEA, `bun build --compile`)               | One file                                                                                                                                 | Postgres still has to come from somewhere; migrations, web assets and the agent skill have to be embedded; per-platform builds and Apple signing for each release. A later step on top of this one, not instead of it |
| Desktop app (Tauri, Electron)                                 | Familiar for non-developers                                                                                                              | An Apple Developer account ($99 a year) and notarization to open without warnings, a release pipeline, and still a Postgres inside. Can wrap this installer's runtime later                                           |
| Homebrew tap, `npx`                                           | Familiar for developers                                                                                                                  | Mac-only or Node-first, and Postgres is still separate                                                                                                                                                                |

## Decision

**`curl -fsSL https://lucidity-finance.github.io/tidysum/install.sh | sh`**, on macOS and Linux
(Windows through WSL). It needs no sudo, no Docker and no Node, and it puts everything in
`~/.tidysum`:

| In `~/.tidysum`               | What it is                                                                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node/v24.x`                  | Node.js LTS from nodejs.org, checked against a sha256 written into `install.sh`                                                                                                                          |
| `app/<commit>`, `app/current` | Tidysum at one exact commit, installed with `pnpm install --prod --frozen-lockfile` (pnpm through Node's corepack), so every package, Postgres included, is the one `pnpm-lock.yaml` locks, hash-checked |
| `postgres/`                   | Tidysum's own PostgreSQL 17 cluster and its log                                                                                                                                                          |
| `.env`                        | Settings, with a fresh `TIDYSUM_TOKEN_KEY` and a free port for the page                                                                                                                                  |
| `bin/tidysum`                 | The command, linked into `~/.local/bin`                                                                                                                                                                  |
| `logs/`, `demo/`, `cache/`    | The service's log, the demo's own Postgres, pnpm's store                                                                                                                                                 |

**Tidysum's own Postgres** (`src/db/localPostgres.ts`) is real PostgreSQL 17 from the
`@embedded-postgres/<platform>` packages (MIT, prebuilt binaries for macOS and Linux on Intel and
ARM), optional dependencies installed only for the platform at hand. With no `DATABASE_URL`, every
command makes the cluster if it isn't there, starts it if it isn't running, and connects. It
listens on a Unix socket only, in a folder only its owner can open, never on a network port, so
trust authentication over that socket is safe. The roles, grants, row-level security and `numeric`
are exactly what the Docker setup has: the whole test suite passes on it (`TEST_PG=local`).

**The `tidysum` command** adds `start`, `stop`, `restart`, `status`, `logs`, `upgrade` and
`uninstall` to the existing commands. `start` runs `tidysum serve` as a launchd agent
(`com.tidysum.app`, not the checkout's `com.tidysum.serve`) on a Mac or a systemd user service on
Linux, at login and again if it exits, and as a plain background process where neither is
available. `upgrade` re-runs the newest installer: it installs the new commit next to the old one,
migrates, switches `app/current` and restarts, and goes back to the old commit if the migration
fails. `uninstall` removes the program and keeps the data.

The installer ends with Tidysum running and its page open. The page starts without Plaid keys and
says what to add when you first link a bank. If Claude Code is installed, it offers to run
`tidysum agent setup`, which for an installed Tidysum registers `~/.tidysum/bin/tidysum mcp` and
allows `tidysum` commands.

The demo no longer needs Docker either: `tidysum demo` (and `pnpm demo` in a checkout) runs a
Postgres of its own in `~/.tidysum/demo` and stops it on exit.

A checkout is unchanged: with `DATABASE_URL` set in `.env`, as on the owner's Mac, Tidysum uses
that database, and `deploy/macos-setup.sh` and auto-deploy work as before.

## Tradeoffs we accept

- **`curl | sh`.** The script is short and readable, runs only once fully downloaded, pins Node by
  hash and Tidysum by commit, and anyone can download and read it first. Hosting it on the project's
  GitHub Pages keeps it on GitHub's infrastructure.
- **Third-party Postgres binaries.** They are maintained, widely used builds, locked by hash in
  `pnpm-lock.yaml`. `TIDYSUM_PG_BIN` points Tidysum at another Postgres 17 `bin` folder, and
  `DATABASE_URL` at any Postgres at all.
- **Postgres major versions.** The cluster is PostgreSQL 17. Moving to 18 later needs an upgrade
  step (`pg_upgrade` or dump and restore) written for it; minor versions need nothing.
- **Updates are manual** (`tidysum upgrade`) and follow `main`, which only moves when CI passes.
  Automatic updates and tagged releases can come later.
- **Disk.** About 500 MB, most of it Node.js, Postgres and its empty database.

## Later

- Saving Plaid keys from the page instead of `.env`.
- Automatic updates, and installing tagged releases instead of `main`.
- A desktop app that wraps this runtime, once the project can pay for signing.

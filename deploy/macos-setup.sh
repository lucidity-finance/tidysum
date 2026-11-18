#!/usr/bin/env bash
# Runs Tidysum in the background on a Mac: Postgres in Docker, `tidysum serve` (admin page on
# 127.0.0.1, scheduled Plaid sync) as a per-user launchd agent that starts at login and restarts
# if it exits. Safe to re-run; it replaces the agent with the current settings.
#
# A third agent, com.tidysum.auto-deploy, runs deploy/auto-deploy.sh every minute: when main moves
# on GitHub it pulls and re-runs this script, so merged changes go live by themselves. Set
# TIDYSUM_AUTO_DEPLOY=off in .env to leave it out.
#
# With TIDYSUM_MINER_DIR in .env, investment-miner (the research sleeve's source) runs next to it
# as a second agent: the miner's own API server on 127.0.0.1:8000, whose scheduler runs the scans
# in the miner's config.yaml (weekdays, UTC). Tidysum reads the results through the miner's CLI.
#
#   deploy/macos-setup.sh            install or update
#   deploy/macos-setup.sh uninstall  stop and remove the agents (keeps the databases)
#
# NODE can point at a specific node binary; by default the newest nvm Node 22.19+ is used, so the
# agent doesn't depend on which Node your shell happens to have first on PATH.
set -euo pipefail

LABEL=com.tidysum.serve
MINER_LABEL=com.tidysum.investment-miner
DEPLOY_LABEL=com.tidysum.auto-deploy
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MINER_PLIST="$HOME/Library/LaunchAgents/$MINER_LABEL.plist"
DEPLOY_PLIST="$HOME/Library/LaunchAgents/$DEPLOY_LABEL.plist"
LOGS="$HOME/Library/Logs/tidysum"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "uninstall" ]]; then
  for l in "$LABEL" "$MINER_LABEL" "$DEPLOY_LABEL"; do
    launchctl bootout "$DOMAIN/$l" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$l.plist"
  done
  echo "removed $LABEL, $MINER_LABEL and $DEPLOY_LABEL (databases left in place)"
  exit 0
fi

# Replaces a launchd agent with the plist given. bootout returns before the old job is gone, and
# bootstrapping over it fails with "5: Input/output error", so wait for it, then retry a few times.
reload_agent() {
  local label="$1" plist="$2"
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  for _ in $(seq 1 20); do
    launchctl print "$DOMAIN/$label" >/dev/null 2>&1 || break
    sleep 0.5
  done
  for attempt in 1 2 3 4 5; do
    launchctl bootstrap "$DOMAIN" "$plist" && return 0
    [ "$attempt" = 5 ] && { echo "launchctl bootstrap of $label failed" >&2; exit 1; }
    sleep 2
  done
}

node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' 2>/dev/null; }

if [[ -z "${NODE:-}" ]]; then
  for candidate in $(ls -d "$HOME"/.nvm/versions/node/v*/bin/node 2>/dev/null | sort -r) "$(command -v node || true)"; do
    if [[ -n "$candidate" ]] && node_ok "$candidate"; then NODE="$candidate"; break; fi
  done
fi
if [[ -z "${NODE:-}" ]] || ! node_ok "$NODE"; then
  echo "need Node 22.19 or later (set NODE=/path/to/node)" >&2
  exit 1
fi

cd "$REPO"
# A manual run records the commit it deployed, so the auto-deployer doesn't deploy it again.
# (When the auto-deployer runs this, it records the commit itself once /healthz answers.)
record_deployed() {
  if [[ "$1" == 0 && -z "${TIDYSUM_AUTO_DEPLOY_RUN:-}" ]]; then
    mkdir -p "$REPO/.deploy" && git -C "$REPO" rev-parse HEAD >"$REPO/.deploy/deployed"
  fi
}
trap 'record_deployed $?' EXIT
[[ -f .env ]] || { echo "missing $REPO/.env (copy .env.example and add the Plaid keys)" >&2; exit 1; }
chmod 600 .env

[[ -f policy.json ]] || { cp policy.example.json policy.json; echo "created policy.json from policy.example.json"; }

NODE_BIN="$(dirname "$NODE")"
export PATH="$NODE_BIN:$PATH"
if command -v pnpm >/dev/null; then pnpm install --frozen-lockfile >/dev/null; else corepack pnpm install --frozen-lockfile >/dev/null; fi
docker compose up -d --wait postgres >/dev/null
"$NODE" --env-file-if-exists=.env --import tsx src/cli.ts migrate
"$NODE" --env-file-if-exists=.env --import tsx src/cli.ts policy set policy.json --if-missing
"$NODE" --env-file-if-exists=.env --import tsx src/cli.ts plan set --if-configured

mkdir -p "$LOGS" "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--env-file-if-exists=.env</string>
    <string>--import</string>
    <string>tsx</string>
    <string>src/cli.ts</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <!-- Restart after a crash or if Postgres wasn't up yet; wait 30s between attempts. -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOGS/serve.log</string>
  <key>StandardErrorPath</key><string>$LOGS/serve.log</string>
</dict>
</plist>
PLIST

reload_agent "$LABEL" "$PLIST"
echo "started $LABEL with $NODE"
echo "admin page: http://127.0.0.1:8080"
echo "logs: $LOGS/serve.log"

# auto-deploy -----------------------------------------------------------------------------------
AUTO_DEPLOY="$(sed -n 's/^TIDYSUM_AUTO_DEPLOY=//p' .env | tail -1)"
if [[ "$AUTO_DEPLOY" == off ]]; then
  if [[ -f "$DEPLOY_PLIST" ]]; then
    launchctl bootout "$DOMAIN/$DEPLOY_LABEL" 2>/dev/null || true
    rm -f "$DEPLOY_PLIST"
    echo "removed $DEPLOY_LABEL (TIDYSUM_AUTO_DEPLOY=off)"
  fi
else
  NEW_DEPLOY_PLIST="$(cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$DEPLOY_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO/deploy/auto-deploy.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOGS/auto-deploy.log</string>
  <key>StandardErrorPath</key><string>$LOGS/auto-deploy.log</string>
</dict>
</plist>
PLIST
)"
  if [[ "$(cat "$DEPLOY_PLIST" 2>/dev/null)" != "$NEW_DEPLOY_PLIST" ]] ||
    ! launchctl print "$DOMAIN/$DEPLOY_LABEL" >/dev/null 2>&1; then
    printf '%s\n' "$NEW_DEPLOY_PLIST" >"$DEPLOY_PLIST"
    if [[ -n "${TIDYSUM_AUTO_DEPLOY_RUN:-}" ]]; then
      # Reloading the agent from inside its own run would kill this deploy; the new plist
      # takes effect at the next login or manual run.
      echo "updated $DEPLOY_PLIST; it takes effect at the next login"
    else
      reload_agent "$DEPLOY_LABEL" "$DEPLOY_PLIST"
      echo "started $DEPLOY_LABEL: merges to main deploy here by themselves"
      echo "logs: $LOGS/auto-deploy.log (last result in $REPO/.deploy/status)"
    fi
  fi
fi

# investment-miner ------------------------------------------------------------------------------
# Its API process is also its scheduler (APScheduler, crons from its config.yaml). The miner says
# to run exactly one scheduler per database; holding port 8000 also stops a second `just serve`.
MINER_DIR="$(sed -n 's/^TIDYSUM_MINER_DIR=//p' .env | tail -1)"
MINER_DIR="${MINER_DIR/#\~/$HOME}"
if [[ -z "$MINER_DIR" ]]; then
  if [[ -f "$MINER_PLIST" ]]; then
    launchctl bootout "$DOMAIN/$MINER_LABEL" 2>/dev/null || true
    rm -f "$MINER_PLIST"
    echo "removed $MINER_LABEL (TIDYSUM_MINER_DIR is unset)"
  fi
  exit 0
fi
[[ -f "$MINER_DIR/config.yaml" ]] || { echo "TIDYSUM_MINER_DIR=$MINER_DIR has no config.yaml" >&2; exit 1; }
UV="${TIDYSUM_MINER_UV:-}"
for candidate in "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv "$(command -v uv || true)"; do
  [[ -z "$UV" && -n "$candidate" && -x "$candidate" ]] && UV="$candidate"
done
[[ -n "$UV" ]] || { echo "investment-miner needs uv (https://docs.astral.sh/uv/)" >&2; exit 1; }

# Its scheduler upgrades an older database in place on first start, so keep a consistent copy
# of the database from before that, once, outside the miner's repo (SQLite's backup API).
BACKUPS="$HOME/Library/Application Support/tidysum/investment-miner-backups"
DB="$MINER_DIR/signals.db"
if [[ -f "$DB" && ! -f "$BACKUPS/signals.before-schedule.db" ]]; then
  mkdir -p "$BACKUPS"
  sqlite3 "$DB" ".backup '$BACKUPS/signals.before-schedule.db'"
  echo "backed up $DB to $BACKUPS/signals.before-schedule.db"
fi
(cd "$MINER_DIR" && "$UV" sync --frozen --extra web >/dev/null)

cat > "$MINER_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$MINER_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$UV</string>
    <string>run</string>
    <string>--frozen</string>
    <string>--no-sync</string>
    <string>uvicorn</string>
    <string>investment_miner.api:app</string>
    <string>--host</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>8000</string>
  </array>
  <key>WorkingDirectory</key><string>$MINER_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$UV"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <!-- launchd jobs get 256 open files by default. A scan fetches hundreds of prices at once
       and yfinance's cache needs a file for each, so at 256 most fetches fail. -->
  <key>SoftResourceLimits</key>
  <dict><key>NumberOfFiles</key><integer>8192</integer></dict>
  <key>HardResourceLimits</key>
  <dict><key>NumberOfFiles</key><integer>8192</integer></dict>
  <key>StandardOutPath</key><string>$LOGS/investment-miner.log</string>
  <key>StandardErrorPath</key><string>$LOGS/investment-miner.log</string>
</dict>
</plist>
PLIST
reload_agent "$MINER_LABEL" "$MINER_PLIST"
echo "started $MINER_LABEL (scans per $MINER_DIR/config.yaml; dashboard http://127.0.0.1:8000)"
echo "logs: $LOGS/investment-miner.log"

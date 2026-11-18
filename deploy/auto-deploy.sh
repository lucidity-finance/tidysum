#!/usr/bin/env bash
# Deploys main to this Mac by itself whenever main moves, so a merged change goes live without
# anyone running a deploy. deploy/macos-setup.sh installs it as the launchd agent
# com.tidysum.auto-deploy, which runs this every minute. Each run:
#
#   1. fetches origin/main (over the clone's own remote; falls back to `gh` over HTTPS),
#   2. does nothing if that commit is already deployed,
#   3. otherwise fast-forwards the clone, runs deploy/macos-setup.sh and waits for /healthz.
#
# A run with nothing to do writes nothing. What happened last is in .deploy/status (one line
# per field, readable by agents through the clone) and the full history in
# ~/Library/Logs/tidysum/auto-deploy.log. Failures post a macOS notification, once per problem,
# and another when deploys work again. A failed deploy is retried twice, then left until main
# moves again.
#
# It never deploys a clone that isn't on main, has edited tracked files, or has local commits
# main doesn't have: it says why and waits. Set TIDYSUM_AUTO_DEPLOY=off in .env and re-run
# deploy/macos-setup.sh to turn it off.
#
# Everything is in functions and the last line exits, so a pull that rewrites this file can't
# change the run that pulled it.
set -uo pipefail

REPO="${TIDYSUM_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
STATE="$REPO/.deploy"
SETUP="${TIDYSUM_SETUP:-$REPO/deploy/macos-setup.sh}"
NOTIFY="${TIDYSUM_NOTIFY:-osascript}"
READY_CHECK="${TIDYSUM_READY_CHECK:-docker info}"
HEALTH_TRIES="${TIDYSUM_HEALTH_TRIES:-45}"
MAX_ATTEMPTS=3
# Fetch failures are usually just the Mac being offline or asleep; only say so after this many
# in a row (one run a minute).
FETCH_FAILURES_BEFORE_NOTICE=15

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "$(now) $*"; }
read_state() { cat "$STATE/$1" 2>/dev/null || true; }
write_state() { printf '%s\n' "$2" >"$STATE/$1"; }

# Shows a macOS notification. The same problem is announced once, not every minute.
notify() {
  local key="$1" message="$2"
  [[ "$(read_state notified)" == "$key" ]] && return 0
  write_state notified "$key"
  log "notify: $message"
  if [[ "$NOTIFY" == osascript ]]; then
    command -v osascript >/dev/null || return 0
    local escaped="${message//\\/\\\\}"
    escaped="${escaped//\"/\\\"}"
    osascript -e "display notification \"$escaped\" with title \"Tidysum\"" >/dev/null 2>&1 || true
  else
    "$NOTIFY" "$message" || true
  fi
}

# Clears the announced problem; if there was one, says that deploys work again.
all_clear() {
  local was
  was="$(read_state notified)"
  [[ -z "$was" ]] && return 0
  rm -f "$STATE/notified"
  [[ "$was" == ok ]] && return 0
  notify ok "Deploys are working again: $1"
}

# Records the outcome in .deploy/status. A repeat of the same outcome (a skip seen every
# minute) isn't logged again.
status() {
  local result="$1" commit="$2" message="$3"
  [[ "$(sed -n '1,2p;4p' "$STATE/status" 2>/dev/null)" == "$(printf 'result=%s\ncommit=%s\nmessage=%s' "$result" "$commit" "$message")" ]] && return 0
  {
    echo "result=$result"
    echo "commit=$commit"
    echo "at=$(now)"
    echo "message=$message"
  } >"$STATE/status"
  log "$result $commit: $message"
}

fetch_main() {
  export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=20}"
  export GIT_TERMINAL_PROMPT=0
  if git fetch --quiet origin main 2>"$STATE/fetch.err"; then return 0; fi
  # launchd jobs don't always see the SSH agent that a terminal does; gh's token works anywhere.
  local url https
  url="$(git remote get-url origin)"
  https="$(sed -E 's#^(ssh://)?git@github\.com[:/]#https://github.com/#' <<<"$url")"
  if [[ "$https" == https://github.com/* ]] && command -v gh >/dev/null &&
    git -c credential.helper= -c 'credential.helper=!gh auth git-credential' \
      fetch --quiet "$https" "+refs/heads/main:refs/remotes/origin/main" 2>>"$STATE/fetch.err"; then
    return 0
  fi
  return 1
}

healthy() {
  local port
  port="$(sed -n 's/^PORT=//p' "$REPO/.env" 2>/dev/null | tail -1)"
  local url="${TIDYSUM_HEALTH_URL:-http://127.0.0.1:${port:-8080}/healthz}"
  for _ in $(seq 1 "$HEALTH_TRIES"); do
    curl -fsS --max-time 3 "$url" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

run_setup() { TIDYSUM_AUTO_DEPLOY_RUN=1 bash "$SETUP" >>"$STATE/last-deploy.log" 2>&1; }

deploy() {
  local target="$1" subject="$2" previous="$3" problem=""
  log "deploying $target ($subject)"
  : >"$STATE/last-deploy.log"
  if ! git merge --ff-only --quiet "$target"; then
    status failed "$target" "could not fast-forward the clone to $target"
    return 1
  fi
  if ! run_setup; then
    problem="deploy/macos-setup.sh failed"
  elif ! healthy; then
    problem="the server did not answer /healthz after the deploy"
  fi
  if [[ -z "$problem" ]]; then
    cat "$STATE/last-deploy.log"
    write_state deployed "$target"
    status ok "$target" "deployed: $subject"
    return 0
  fi
  # Put the version that was running back, so a bad merge doesn't leave Tidysum down.
  log "$problem; rolling back to $previous"
  echo "--- rolling back to $previous" >>"$STATE/last-deploy.log"
  if git reset --quiet --hard "$previous" && run_setup && healthy; then
    write_state deployed "$previous"
    status failed "$target" "$problem; rolled back to $(git log -1 --format=%h "$previous") (see .deploy/last-deploy.log)"
  else
    status failed "$target" "$problem, and the rollback to $previous failed too (see .deploy/last-deploy.log)"
  fi
  cat "$STATE/last-deploy.log"
  return 1
}

main() {
  export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.docker/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
  cd "$REPO" || exit 1
  mkdir -p "$STATE"

  # One deploy at a time; a lock older than half an hour is from a run that died.
  if ! mkdir "$STATE/lock" 2>/dev/null; then
    if [[ -n "$(find "$STATE/lock" -maxdepth 0 -mmin +30 2>/dev/null)" ]]; then
      rm -rf "$STATE/lock"
      mkdir "$STATE/lock" 2>/dev/null || return 0
    else
      return 0
    fi
  fi
  trap 'rm -rf "$STATE/lock"' EXIT

  if ! fetch_main; then
    local failures
    failures=$(($(read_state fetch-failures) + 1))
    write_state fetch-failures "$failures"
    if ((failures == FETCH_FAILURES_BEFORE_NOTICE)); then
      log "fetch failing for $failures runs: $(tr '\n' ' ' <"$STATE/fetch.err")"
      status fetch_failed "" "can't fetch main from GitHub: $(head -1 "$STATE/fetch.err")"
      notify fetch "Auto-deploy can't reach GitHub to check for updates. Details: ~/Library/Logs/tidysum/auto-deploy.log"
    fi
    return 0
  fi
  rm -f "$STATE/fetch-failures"

  local target head deployed subject
  target="$(git rev-parse origin/main)"
  head="$(git rev-parse HEAD)"
  deployed="$(read_state deployed)"
  [[ "$target" == "$deployed" ]] && return 0
  subject="$(git log -1 --format=%s "$target")"

  local branch
  branch="$(git symbolic-ref --quiet --short HEAD || echo detached)"
  if [[ "$branch" != main ]]; then
    status skipped "$target" "the clone is on $branch, not main"
    notify "branch:$branch" "Not deploying: your Tidysum folder is on branch $branch, not main."
    return 0
  fi
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    status skipped "$target" "tracked files are edited in the clone"
    notify "dirty:$target" "Not deploying $subject: files in your Tidysum folder have local edits."
    return 0
  fi
  if ! git merge-base --is-ancestor "$head" "$target"; then
    status skipped "$target" "the clone has commits main doesn't have"
    notify "diverged:$head" "Not deploying: your Tidysum folder has local commits that aren't on main."
    return 0
  fi

  # Postgres runs in Docker Desktop; deploying before it's up (just after login) only fails.
  if ! $READY_CHECK >/dev/null 2>&1; then
    local waits
    waits=$(($(read_state docker-waits) + 1))
    write_state docker-waits "$waits"
    status skipped "$target" "waiting for Docker Desktop to start"
    ((waits >= 5)) && notify docker "Not deploying $subject yet: Docker Desktop isn't running."
    return 0
  fi
  rm -f "$STATE/docker-waits"

  # Retry a failing commit a couple of times (Docker may still be starting after login), then
  # leave it until main moves.
  local attempts=0
  [[ "$(read_state failed-commit)" == "$target" ]] && attempts="$(read_state failed-attempts)"
  if ((attempts >= MAX_ATTEMPTS)); then return 0; fi

  if deploy "$target" "$subject" "$head"; then
    rm -f "$STATE/failed-commit" "$STATE/failed-attempts"
    all_clear "$subject"
  else
    write_state failed-commit "$target"
    write_state failed-attempts $((attempts + 1))
    if ((attempts + 1 >= MAX_ATTEMPTS)); then
      notify "failed:$target" "Deploy failed: $subject. Tidysum went back to the previous version. Details: .deploy/last-deploy.log"
    fi
  fi
  return 0
}

main "$@"; exit $?

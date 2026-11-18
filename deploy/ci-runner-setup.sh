#!/usr/bin/env bash
set -euo pipefail

# Installs the GitHub Actions self-hosted runner that runs this repository's CI, so CI spends no
# GitHub-hosted minutes (self-hosted runner minutes are free).
#
#   tidysum-ci   Branch checks. Runs as user tidysum-ci with no Docker, sudo or SSH access, at low CPU, IO
#               and memory priority so whatever else runs on the host wins when they compete.
#
# Tests need Postgres but the runner has no Docker, so this installs the distro's PostgreSQL binaries
# without a running cluster. Each CI run starts a throwaway cluster in its own temp directory on a Unix
# socket (test/globalSetup.ts, TEST_PG_BIN) and deletes it afterwards. Nothing listens on TCP.
#
# Run as root on the host with the repository's URL and a runner registration token (valid for one hour):
#   REPO_URL=https://github.com/<owner>/tidysum RUNNER_TOKEN=... bash ci-runner-setup.sh
# or from a laptop:
#   repo=<owner>/tidysum
#   token="$(gh api -X POST "repos/$repo/actions/runners/registration-token" --jq .token)"
#   ssh root@<host> "REPO_URL=https://github.com/$repo RUNNER_TOKEN=$token bash -s" < deploy/ci-runner-setup.sh
# Rerunning is safe. A registered runner keeps its registration, so later runs need no token.

# The braces make bash read the whole script before running it. Piped into `bash -s`, a command that reads
# stdin (apt) would otherwise swallow the rest of the script and end it silently.
{
runner_root='/opt/actions-runner'
name='tidysum-ci'
user='tidysum-ci'

die() { printf '%s\n' "$*" >&2; exit 1; }
(( EUID == 0 )) || die 'Run as root on the runner host.'
# shellcheck source=/dev/null
. /etc/os-release
[[ "$ID" == ubuntu && "$(uname -m)" == x86_64 ]] || die "Expected Ubuntu on x86_64, found $ID on $(uname -m)."

work="$(mktemp -d /tmp/tidysum-runner-setup.XXXXXX)"
chmod 755 "$work"
trap 'rm -rf -- "$work"' EXIT

printf 'Installing git, curl, jq and the PostgreSQL binaries (no cluster)...\n'
export DEBIAN_FRONTEND=noninteractive
# Without this, installing postgresql creates and starts a main cluster on port 5432.
install -d -m 755 /etc/postgresql-common
conf=/etc/postgresql-common/createcluster.conf
if ! grep -qE '^\s*create_main_cluster\s*=\s*false' "$conf" 2>/dev/null; then
  printf 'create_main_cluster = false\n' >> "$conf"
fi
apt-get update -qq
apt-get install -y -qq --no-install-recommends git curl jq ca-certificates postgresql >/dev/null
pg_bin="$(find /usr/lib/postgresql -maxdepth 2 -name bin -type d | sort -V | tail -1)"
[[ -x "$pg_bin/initdb" ]] || die 'PostgreSQL binaries not found under /usr/lib/postgresql.'
printf 'PostgreSQL binaries at %s\n' "$pg_bin"

id -u "$user" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/var/lib/$user" --shell /bin/bash "$user"

printf 'Downloading the latest GitHub Actions runner...\n'
release="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest)"
runner_version="$(jq -r .tag_name <<<"$release")"
runner_version="${runner_version#v}"
runner_sha="$(jq -r .body <<<"$release" | sed -nE 's/.*<!-- BEGIN SHA linux-x64 -->([0-9a-f]{64})<!-- END SHA linux-x64 -->.*/\1/p' | head -1)"
[[ "$runner_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && -n "$runner_sha" ]] || die 'Could not read the runner release and checksum.'
runner_tar="$work/actions-runner-linux-x64-${runner_version}.tar.gz"
curl -fsSL "https://github.com/actions/runner/releases/download/v${runner_version}/actions-runner-linux-x64-${runner_version}.tar.gz" -o "$runner_tar"
printf '%s  %s\n' "$runner_sha" "$runner_tar" | sha256sum -c --quiet -

dir="$runner_root/$name"
if [[ -f "$dir/.runner" ]]; then
  printf '%s is already registered.\n' "$name"
else
  [[ -n "${RUNNER_TOKEN:-}" ]] || die "Set RUNNER_TOKEN to register $name (Settings > Actions > Runners > New self-hosted runner)."
  [[ -n "${REPO_URL:-}" ]] || die "Set REPO_URL to the repository, like https://github.com/<owner>/tidysum."
  install -d -m 750 -o "$user" -g "$user" "$dir"
  tar -xzf "$runner_tar" -C "$dir"
  chown -R "$user:$user" "$dir"
  (cd "$dir" && ./bin/installdependencies.sh >/dev/null)
  (cd "$dir" && sudo -u "$user" -H ./config.sh --unattended --replace --url "$REPO_URL" --token "$RUNNER_TOKEN" \
    --name "$name" --labels "$name" --work _work)
fi
if [[ ! -f "$dir/.service" ]]; then
  (cd "$dir" && ./svc.sh install "$user" >/dev/null)
fi

changed=false

# Jobs get TEST_PG_BIN from the runner's .env file, which the runner reads when it starts.
env_file="$dir/.env"
touch "$env_file"
if ! grep -qx "TEST_PG_BIN=$pg_bin" "$env_file"; then
  sed -i '/^TEST_PG_BIN=/d' "$env_file"
  printf 'TEST_PG_BIN=%s\n' "$pg_bin" >> "$env_file"
  changed=true
fi
chown "$user:$user" "$env_file"

unit="$(cat "$dir/.service")"
# CI uses whatever the host leaves idle. Tidysum's checks are small: typecheck, lint, and tests on a temp Postgres.
limits=$'[Service]\nNice=10\nCPUWeight=20\nIOWeight=20\nMemoryHigh=1500M\nMemoryMax=2500M'
install -d "/etc/systemd/system/$unit.d"
dropin="/etc/systemd/system/$unit.d/tidysum.conf"
if [[ "$(cat "$dropin" 2>/dev/null)" != "$limits" ]]; then
  printf '%s\n' "$limits" > "$dropin"
  changed=true
fi
systemctl daemon-reload
if [[ "$changed" == true ]] && systemctl is-active --quiet "$unit"; then
  # A restart waits up to five minutes for a running job, then cancels it. Only new settings need one.
  printf 'Restarting %s for its new settings...\n' "$name"
  systemctl restart "$unit"
fi
systemctl enable --now "$unit" >/dev/null 2>&1
systemctl is-active --quiet "$unit" || die "$unit did not start."
printf '%s is running as %s (%s). Check it under Settings > Actions > Runners.\n' "$name" "$user" "$unit"
exit
}

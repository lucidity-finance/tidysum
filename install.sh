#!/bin/sh
# Installs Tidysum on macOS or Linux, in one step:
#
#   curl -fsSL https://lucidity-finance.github.io/tidysum/install.sh | sh
#
# Everything goes in one folder, ~/.tidysum: its own Node.js (checked against the checksum below),
# Tidysum at one exact commit, its own PostgreSQL 17 (prebuilt binaries, locked in pnpm-lock.yaml)
# and your data. Nothing is installed system-wide and nothing needs sudo or Docker. It adds the
# `tidysum` command to ~/.local/bin, starts Tidysum in the background (at login too) and opens
# http://127.0.0.1:8080. Run it again, or `tidysum upgrade`, to update. Why it works this way:
# docs/decisions/0012-one-step-install.md.
#
# Settings, all optional, as environment variables:
#   TIDYSUM_HOME            where it all goes (default ~/.tidysum)
#   TIDYSUM_REF             branch, tag or commit to install (default main)
#   TIDYSUM_BIN_DIR         where the `tidysum` command is linked (default ~/.local/bin)
#   TIDYSUM_NO_MODIFY_PATH  1: don't add that folder to your shell's PATH
#   TIDYSUM_NO_START        1: install only; `tidysum start` starts it later
#   TIDYSUM_SOURCE          a local checkout or .tar.gz to install instead of downloading one
#
# The whole script is inside main(), so a download cut off halfway runs nothing.

set -eu

REPO="lucidity-finance/tidysum"
NODE_VERSION="24.22.3"

say() { printf '%s\n' "$*"; }
step() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() {
  printf 'tidysum install: %s\n' "$*" >&2
  exit 1
}

# Node.js $NODE_VERSION from nodejs.org, by platform: the sha256 of its .tar.gz (SHASUMS256.txt).
node_sha256() {
  case "$1" in
  darwin-arm64) echo ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd ;;
  darwin-x64) echo 977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7 ;;
  linux-arm64) echo 261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8 ;;
  linux-x64) echo 061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2 ;;
  *) return 1 ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

detect_platform() {
  case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "Tidysum installs on macOS and Linux. On Windows, run this inside WSL." ;;
  esac
  case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) die "no build for $(uname -m) processors" ;;
  esac
  # A Terminal running under Rosetta on an Apple silicon Mac still gets the native build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
  platform="$os-$arch"
}

# Shell-quotes one value for the launcher.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

install_node() {
  node_dir="$home/node/v$NODE_VERSION"
  if [ ! -x "$node_dir/bin/node" ]; then
    step "Downloading Node.js $NODE_VERSION"
    want="$(node_sha256 "$platform")" || die "no Node.js build for $platform"
    file="$tmp/node.tar.gz"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$platform.tar.gz" -o "$file" ||
      die "couldn't download Node.js"
    [ "$(sha256_of "$file")" = "$want" ] || die "Node.js download doesn't match its checksum"
    rm -rf "$node_dir.part" && mkdir -p "$node_dir.part"
    tar -xzf "$file" -C "$node_dir.part" --strip-components=1
    mv "$node_dir.part" "$node_dir"
  fi
  ln -sfn "v$NODE_VERSION" "$home/node/current"
  node="$node_dir/bin/node"
}

# Puts Tidysum's source in $tmp/src and its commit in $commit.
fetch_source() {
  src="$tmp/src"
  mkdir -p "$src"
  if [ -n "${TIDYSUM_SOURCE:-}" ]; then
    # A local copy is installed afresh every time, under a name of its own.
    step "Copying Tidysum from $TIDYSUM_SOURCE"
    commit="local-$(date +%Y%m%d%H%M%S)"
    if [ -d "$TIDYSUM_SOURCE" ]; then
      (cd "$TIDYSUM_SOURCE" && tar -cf - --exclude=./node_modules --exclude=./.git .) | tar -xf - -C "$src"
    else
      tar -xzf "$TIDYSUM_SOURCE" -C "$src" --strip-components=1
    fi
    return
  fi
  ref="${TIDYSUM_REF:-main}"
  if printf '%s' "$ref" | grep -Eq '^[0-9a-f]{40}$'; then
    commit="$ref"
  else
    commit="$(curl -fsSL -H "Accept: application/vnd.github.sha" "https://api.github.com/repos/$REPO/commits/$ref")" ||
      die "couldn't look up $ref on GitHub"
    printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$' || die "GitHub didn't return a commit for $ref"
  fi
  if [ -f "$home/app/$commit/.commit" ]; then
    return
  fi
  step "Downloading Tidysum ${commit%"${commit#????????????}"}"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$commit" -o "$tmp/tidysum.tar.gz" ||
    die "couldn't download Tidysum"
  tar -xzf "$tmp/tidysum.tar.gz" -C "$src" --strip-components=1
}

install_app() {
  app_dir="$home/app/$commit"
  [ -f "$app_dir/.commit" ] && return
  step "Installing Tidysum's packages (and its own PostgreSQL)"
  rm -rf "$app_dir" "$app_dir.part"
  mkdir -p "$home/app"
  mv "$src" "$app_dir.part"
  # corepack (part of Node.js) fetches the exact pnpm package.json names; pnpm installs exactly
  # what pnpm-lock.yaml locks, checking every package's hash. Its store stays in ~/.tidysum too.
  if ! (cd "$app_dir.part" &&
    PATH="$node_dir/bin:$PATH" COREPACK_HOME="$home/cache/corepack" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
      "$node_dir/bin/corepack" pnpm install --prod --frozen-lockfile --store-dir "$home/cache/pnpm-store" \
      >"$tmp/pnpm.log" 2>&1); then
    tail -n 30 "$tmp/pnpm.log" >&2
    die "installing packages failed"
  fi
  printf '%s\n' "$commit" >"$app_dir.part/.commit"
  mv "$app_dir.part" "$app_dir"
}

write_launcher() {
  mkdir -p "$home/bin"
  cat >"$home/bin/tidysum.next" <<EOF
#!/bin/sh
# The tidysum command, written by Tidysum's installer (install.sh); \`tidysum upgrade\` rewrites it.
TIDYSUM_HOME=$(quote "$home")
TIDYSUM_LAUNCHER="\$TIDYSUM_HOME/bin/tidysum"
export TIDYSUM_HOME TIDYSUM_LAUNCHER
bin_link=$(quote "$bin_dir/tidysum")
app="\$TIDYSUM_HOME/app/current"
node="\$TIDYSUM_HOME/node/current/bin/node"
run() {
  "\$node" --env-file-if-exists="\$TIDYSUM_HOME/.env" --import "file://\$app/node_modules/tsx/dist/loader.mjs" "\$app/src/cli.ts" "\$@"
}
case "\${1:-}" in
upgrade)
  shift
  installer="\$(mktemp)"
  curl -fsSL "\${TIDYSUM_INSTALL_URL:-https://lucidity-finance.github.io/tidysum/install.sh}" -o "\$installer" &&
    sh "\$installer" --upgrade "\$@"
  status=\$?
  rm -f "\$installer"
  exit \$status
  ;;
uninstall)
  run uninstall || exit 1
  [ -L "\$bin_link" ] && rm -f "\$bin_link"
  rm -rf "\$TIDYSUM_HOME/app" "\$TIDYSUM_HOME/node" "\$TIDYSUM_HOME/cache" "\$TIDYSUM_HOME/bin"
  echo "Tidysum is removed. Your data (its database, .env and logs) is still in \$TIDYSUM_HOME;"
  echo "delete that folder to remove it too."
  exit 0
  ;;
esac
exec "\$node" --env-file-if-exists="\$TIDYSUM_HOME/.env" --import "file://\$app/node_modules/tsx/dist/loader.mjs" "\$app/src/cli.ts" "\$@"
EOF
  chmod 755 "$home/bin/tidysum.next"
  mv -f "$home/bin/tidysum.next" "$home/bin/tidysum"
  launcher="$home/bin/tidysum"
}

# The first free port from 8080 on, for the page.
free_port() {
  "$node" -e '
    const net = require("node:net");
    const tryPort = (p) => {
      const s = net.createServer();
      s.once("error", () => tryPort(p + 1));
      s.listen(p, "127.0.0.1", () => s.close(() => console.log(p)));
    };
    tryPort(8080);'
}

write_env() {
  [ -f "$home/.env" ] && return
  key="$("$node" -e 'console.log(require("node:crypto").randomBytes(32).toString("base64"))')"
  port="$(free_port)"
  umask 077
  cat >"$home/.env" <<EOF
# Tidysum's settings. Every setting is explained in $home/app/current/.env.example.
# After a change: tidysum restart

# Your free Plaid account's keys (Developers -> Keys at dashboard.plaid.com), and
# PLAID_ENV=production for your real accounts. Step by step:
# https://github.com/$REPO/blob/main/docs/connect-your-accounts.md
PLAID_CLIENT_ID=
PLAID_SECRET=
PLAID_ENV=sandbox

# Encrypts your bank connections' tokens. Losing it means linking every account again.
TIDYSUM_TOKEN_KEY=$key

# The page, on this computer only.
HOST=127.0.0.1
PORT=$port

# Empty: Tidysum runs its own PostgreSQL in $home/postgres.
DATABASE_URL=
EOF
  umask 022
  chmod 600 "$home/.env"
}

activate() {
  previous="$(readlink "$home/app/current" 2>/dev/null || true)"
  ln -sfn "$commit" "$home/app/current"
  step "Setting up the database"
  if ! "$launcher" migrate >"$tmp/migrate.log" 2>&1; then
    cat "$tmp/migrate.log" >&2
    if [ -n "$previous" ] && [ "$previous" != "$commit" ]; then
      ln -sfn "$previous" "$home/app/current"
      die "the update couldn't set up the database; Tidysum is back on the version you had"
    fi
    die "couldn't set up the database"
  fi
  "$launcher" policy set "$home/app/current/policy.example.json" --if-missing >/dev/null
  # Keep the version before this one, for going back by hand; drop older ones.
  for dir in "$home"/app/*; do
    name="${dir##*/}"
    case "$name" in current | "$commit" | "$previous") continue ;; esac
    rm -rf "$dir"
  done
}

link_command() {
  mkdir -p "$bin_dir"
  if [ -e "$bin_dir/tidysum" ] && [ ! -L "$bin_dir/tidysum" ]; then
    say "Left $bin_dir/tidysum as it is (it isn't ours). The command is $launcher."
    return
  fi
  ln -sfn "$launcher" "$bin_dir/tidysum"
  case ":$PATH:" in *":$bin_dir:"*) return ;; esac
  [ "${TIDYSUM_NO_MODIFY_PATH:-}" = 1 ] && return
  marker="# added by Tidysum's installer"
  case "${SHELL:-}" in
  */fish)
    rc="$HOME/.config/fish/conf.d/tidysum.fish"
    line="fish_add_path -g $(quote "$bin_dir") $marker"
    ;;
  */zsh)
    rc="${ZDOTDIR:-$HOME}/.zshrc"
    line="export PATH=$(quote "$bin_dir"):\"\$PATH\" $marker"
    ;;
  */bash)
    if [ "$os" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi
    line="export PATH=$(quote "$bin_dir"):\"\$PATH\" $marker"
    ;;
  *)
    rc="$HOME/.profile"
    line="export PATH=$(quote "$bin_dir"):\"\$PATH\" $marker"
    ;;
  esac
  if ! grep -qs "$marker" "$rc"; then
    mkdir -p "$(dirname "$rc")"
    printf '\n%s\n' "$line" >>"$rc"
    say "Added $bin_dir to your PATH in $rc (new terminals have the tidysum command)."
  fi
  path_note=1
}

offer_agent() {
  command -v claude >/dev/null 2>&1 || return 0
  # Ask only when there is a terminal to answer in (not under CI, or with no terminal attached).
  (: </dev/tty) 2>/dev/null || return 0
  printf '\nConnect Claude Code to Tidysum now (its MCP server, skill and permissions; nothing that can move money)? [Y/n] '
  answer=""
  read -r answer </dev/tty || answer=n
  case "$answer" in
  "" | y | Y | yes) "$launcher" agent setup ;;
  *) say "Later: tidysum agent setup" ;;
  esac
}

main() {
  upgrade=""
  for arg in "$@"; do
    case "$arg" in
    --upgrade) upgrade=1 ;;
    *) die "unknown option $arg" ;;
    esac
  done
  [ "$(id -u)" != 0 ] || die "run this as your normal user, not root (Tidysum's PostgreSQL won't run as root)"
  command -v curl >/dev/null 2>&1 || die "needs curl"
  command -v tar >/dev/null 2>&1 || die "needs tar"
  detect_platform

  home="${TIDYSUM_HOME:-$HOME/.tidysum}"
  bin_dir="${TIDYSUM_BIN_DIR:-$HOME/.local/bin}"
  path_note=""
  mkdir -p "$home"
  chmod 700 "$home"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/tidysum-install.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT INT TERM

  install_node
  fetch_source
  if [ "$(readlink "$home/app/current" 2>/dev/null || true)" = "$commit" ] &&
    [ -f "$home/app/$commit/.commit" ]; then
    write_launcher
    say "Tidysum is up to date (${commit%"${commit#????????????}"})."
    exit 0
  fi
  install_app
  write_launcher
  write_env
  activate
  link_command

  if [ -n "$upgrade" ]; then
    "$launcher" restart
    say "Tidysum is updated to ${commit%"${commit#????????????}"}."
    exit 0
  fi
  if [ "${TIDYSUM_NO_START:-}" = 1 ]; then
    say "Installed. Start it with: tidysum start"
  else
    step "Starting Tidysum"
    "$launcher" start --open
  fi
  offer_agent
  port="$(sed -n 's/^PORT=//p' "$home/.env" | tail -n 1)"
  cat <<EOF

Tidysum is installed in $home.

  Open it:            http://127.0.0.1:${port:-8080}
  Try the demo:       tidysum demo        (a made-up household, no bank needed)
  Connect your banks: a free Plaid account, two keys in $home/.env, then tidysum restart.
                      Your AI agent can do it: https://github.com/$REPO/blob/main/docs/connect-your-accounts.md
  Connect your agent: tidysum agent setup  (Claude Code), or any MCP client: tidysum mcp

  tidysum status | stop | start | logs | upgrade | uninstall
EOF
  if [ -n "$path_note" ]; then
    say ""
    say "Open a new terminal for the tidysum command (or run: export PATH=\"$bin_dir:\$PATH\")."
  fi
}

main "$@"

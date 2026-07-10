#!/usr/bin/env bash
# komado installer - fetches the app, builds it, and drops a `komado` launcher on
# your PATH. Safe to re-run any time to update to the latest version.
#
#   curl -fsSL https://raw.githubusercontent.com/RyuPrad/komado/main/install.sh | bash
#
# Overridable via env: KOMADO_REPO, KOMADO_APP_DIR, KOMADO_BIN_DIR.
set -euo pipefail

REPO="${KOMADO_REPO:-https://github.com/RyuPrad/komado.git}"
APP_DIR="${KOMADO_APP_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/komado}"
BIN_DIR="${KOMADO_BIN_DIR:-$HOME/.local/bin}"

say()  { printf '\033[1;36m▸\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# A configured install path is allowed to be absent, empty, or an existing
# komado git checkout.  In particular, never treat an arbitrary non-empty
# KOMADO_APP_DIR as disposable just because an update failed.
is_komado_checkout() {
  [ -d "$1" ] && [ ! -L "$1" ] && [ -e "$1/.git" ] && [ -f "$1/package.json" ] \
    || return 1
  local prefix
  # --show-prefix is empty only at the worktree root and avoids comparing
  # Git-for-Windows `C:/...` output with Git Bash `pwd` output (`/c/...`).
  prefix=$(git -C "$1" rev-parse --show-prefix 2>/dev/null) || return 1
  [ -z "$prefix" ] \
    && node -e 'const p = require(process.argv[1]); process.exit(p.name === "komado" ? 0 : 1)' \
      "$1/package.json" >/dev/null 2>&1
}

# Resolve a directory path through its longest existing ancestor without
# creating the directory. This lets us reject BIN_DIR-inside-APP_DIR before a
# bad override can put files into (or create) the application target.
canonical_future_dir() {
  local candidate="$1" suffix="" parent name
  while [ ! -e "$candidate" ]; do
    parent=$(dirname "$candidate")
    name=$(basename "$candidate")
    [ "$parent" != "$candidate" ] || return 1
    suffix="/$name$suffix"
    candidate="$parent"
  done
  [ -d "$candidate" ] || return 1
  candidate=$(cd "$candidate" && pwd -P) || return 1
  printf '%s%s' "$candidate" "$suffix"
}

normalize_absolute_path() {
  local input="$1" part result=""
  local -a parts stack=()
  IFS='/' read -r -a parts <<< "$input"
  for part in "${parts[@]}"; do
    case "$part" in
      ''|.) ;;
      ..)
        if [ "${#stack[@]}" -gt 0 ]; then unset "stack[${#stack[@]}-1]"; fi
        ;;
      *) stack+=("$part") ;;
    esac
  done
  for part in "${stack[@]}"; do result="$result/$part"; done
  printf '%s' "${result:-/}"
}

dir_is_empty() {
  [ -d "$1" ] && [ -r "$1" ] && [ -x "$1" ] || return 1
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    if [ -e "$entry" ] || [ -L "$entry" ]; then return 1; fi
  done
  return 0
}

# --- preconditions --------------------------------------------------------
command -v git  >/dev/null 2>&1 || die "git is required."
command -v npm  >/dev/null 2>&1 || die "npm is required."
command -v node >/dev/null 2>&1 || die "Node.js >= 20 is required - see https://nodejs.org"
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$node_major" -ge 20 ] || die "Node.js >= 20 required (found $(node -v))."
# Normalize with POSIX shell paths. Native Node under Git Bash can emit
# `C:\...`, which bash tools do not interpret as an absolute sibling path.
case "$APP_DIR" in /*) ;; *) APP_DIR="$(pwd -P)/$APP_DIR" ;; esac
APP_DIR=$(normalize_absolute_path "$APP_DIR")
APP_PARENT=$(dirname "$APP_DIR")
mkdir -p "$APP_PARENT"
APP_PARENT=$(cd "$APP_PARENT" && pwd -P)
APP_NAME=$(basename "$APP_DIR")
case "$APP_NAME" in .|..|/) die "KOMADO_APP_DIR must name an application directory." ;; esac
APP_DIR="$APP_PARENT/$APP_NAME"

# Validate the application before doing anything with BIN_DIR. In particular,
# a bad nested BIN_DIR must not create content that turns an absent/empty app
# target into a non-empty directory the next install refuses to touch.
if [ -e "$APP_DIR" ] || [ -L "$APP_DIR" ]; then
  [ -d "$APP_DIR" ] && [ ! -L "$APP_DIR" ] \
    || die "Refusing to replace $APP_DIR: it is not a directory."
  if ! dir_is_empty "$APP_DIR" && ! is_komado_checkout "$APP_DIR"; then
    die "Refusing to replace non-empty $APP_DIR: it is not a komado git checkout."
  fi
fi

case "$BIN_DIR" in /*) ;; *) BIN_DIR="$(pwd -P)/$BIN_DIR" ;; esac
BIN_DIR=$(normalize_absolute_path "$BIN_DIR")
BIN_DIR=$(canonical_future_dir "$BIN_DIR") \
  || die "KOMADO_BIN_DIR must resolve beneath an existing directory."
case "$BIN_DIR/" in
  "$APP_DIR/"*) die "KOMADO_BIN_DIR must be outside KOMADO_APP_DIR." ;;
esac
mkdir -p "$BIN_DIR"
BIN_DIR=$(cd "$BIN_DIR" && pwd -P)
[ ! -d "$BIN_DIR/komado" ] \
  || die "Refusing to replace $BIN_DIR/komado: it is a directory."

if ! command -v chafa >/dev/null 2>&1; then
  hint="install chafa for the crisp pixel viewer"
  if   command -v apt    >/dev/null 2>&1; then hint="sudo apt install chafa"
  elif command -v brew   >/dev/null 2>&1; then hint="brew install chafa"
  elif command -v dnf    >/dev/null 2>&1; then hint="sudo dnf install chafa"
  elif command -v pacman >/dev/null 2>&1; then hint="sudo pacman -S chafa"
  fi
  warn "chafa not found - $hint  (without it, komado falls back to character-cell rendering)"
fi

# --- stage / build --------------------------------------------------------
# Do all fallible work next to the live install.  A sibling is on the same
# filesystem, making the final rename atomic on normal Unix filesystems.
STAGE_DIR=$(mktemp -d "${APP_DIR}.tmp.XXXXXX") \
  || die "Could not create a staging directory beside $APP_DIR."
BACKUP_DIR=""
LAUNCHER_STAGE=""
LAUNCHER_BACKUP=""
LAUNCHER_INSTALLED=0
APP_ACTIVATED=0

# On interruption or a failed final rename, remove only the installer-created
# staging tree and put the old install back if it was already moved aside.
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ]; then
    rm -rf "$STAGE_DIR" || warn "Could not remove staging directory $STAGE_DIR"
  fi
  if [ -n "$LAUNCHER_STAGE" ] && [ -e "$LAUNCHER_STAGE" ]; then
    rm -f "$LAUNCHER_STAGE" || warn "Could not remove staged launcher $LAUNCHER_STAGE"
  fi
  if [ "$APP_ACTIVATED" = 1 ] && [ -e "$APP_DIR" ]; then
    rm -rf "$APP_DIR" || warn "Could not remove failed replacement at $APP_DIR"
  fi
  if [ -n "$BACKUP_DIR" ] && [ -e "$BACKUP_DIR" ] && [ ! -e "$APP_DIR" ]; then
    mv "$BACKUP_DIR" "$APP_DIR" \
      || warn "Rollback failed; the previous install is still at $BACKUP_DIR"
  fi
  if [ "$LAUNCHER_INSTALLED" = 1 ] && { [ -e "$BIN_DIR/komado" ] || [ -L "$BIN_DIR/komado" ]; }; then
    rm -f "$BIN_DIR/komado" || warn "Could not remove failed launcher at $BIN_DIR/komado"
  fi
  if [ -n "$LAUNCHER_BACKUP" ] \
      && { [ -e "$LAUNCHER_BACKUP" ] || [ -L "$LAUNCHER_BACKUP" ]; } \
      && [ ! -e "$BIN_DIR/komado" ] && [ ! -L "$BIN_DIR/komado" ]; then
    mv "$LAUNCHER_BACKUP" "$BIN_DIR/komado" \
      || warn "Launcher rollback failed; the previous launcher is still at $LAUNCHER_BACKUP"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if is_komado_checkout "$APP_DIR"; then
  say "Preparing an update for komado in $APP_DIR"
else
  say "Downloading komado → $APP_DIR"
fi
git clone --depth 1 "$REPO" "$STAGE_DIR"
is_komado_checkout "$STAGE_DIR" \
  || die "Downloaded repository does not identify itself as a komado git checkout."

say "Installing dependencies and building (one-time, ~a minute)"
if [ -f "$STAGE_DIR/package-lock.json" ]; then
  ( cd "$STAGE_DIR" && npm ci --no-audit --no-fund --loglevel=error )
else
  ( cd "$STAGE_DIR" && npm install --no-audit --no-fund --loglevel=error )
fi
# Runtime needs only `dependencies`; drop build/test tooling to slim the install.
( cd "$STAGE_DIR" && npm prune --omit=dev --no-audit --no-fund --loglevel=error >/dev/null )
[ -f "$STAGE_DIR/dist/cli.js" ] \
  || die "build failed: the staged dist/cli.js was not produced."
( cd "$STAGE_DIR" && node dist/cli.js --version >/dev/null ) \
  || die "build failed: the staged CLI could not start."

# Prepare and activate the launcher before swapping the application. All
# fallible BIN_DIR work therefore leaves an existing application untouched;
# on update the launcher keeps pointing at the same APP_DIR throughout.
LAUNCHER_STAGE=$(mktemp "$BIN_DIR/.komado.tmp.XXXXXX") \
  || die "Could not stage the komado launcher in $BIN_DIR."
cat > "$LAUNCHER_STAGE" <<EOF
#!/usr/bin/env bash
exec node "$APP_DIR/dist/cli.js" "\$@"
EOF
chmod +x "$LAUNCHER_STAGE"
if [ -e "$BIN_DIR/komado" ] || [ -L "$BIN_DIR/komado" ]; then
  LAUNCHER_BACKUP=$(mktemp "$BIN_DIR/.komado.backup.XXXXXX") \
    || die "Could not reserve a launcher rollback path in $BIN_DIR."
  rm -f "$LAUNCHER_BACKUP"
  mv "$BIN_DIR/komado" "$LAUNCHER_BACKUP"
fi
LAUNCHER_INSTALLED=1
mv "$LAUNCHER_STAGE" "$BIN_DIR/komado"
LAUNCHER_STAGE=""

# --- deploy ---------------------------------------------------------------
# Keep the previous checkout intact until the staged one is known-good.  The
# old directory is restored if moving the replacement into place fails.
if [ -e "$APP_DIR" ]; then
  BACKUP_DIR=$(mktemp -d "${APP_DIR}.backup.XXXXXX") \
    || die "Could not reserve a rollback path beside $APP_DIR."
  rmdir "$BACKUP_DIR"
  mv "$APP_DIR" "$BACKUP_DIR"
fi
APP_ACTIVATED=1
mv "$STAGE_DIR" "$APP_DIR" || die "Could not activate the staged komado install."
STAGE_DIR=""

# Commit: both application and launcher are active. From here, interruption
# should leave the valid new install in place; old backups are cleanup only.
APP_ACTIVATED=0
LAUNCHER_INSTALLED=0
trap - EXIT HUP INT TERM
if [ -n "$BACKUP_DIR" ]; then
  rm -rf "$BACKUP_DIR" || warn "Could not remove old install at $BACKUP_DIR"
  BACKUP_DIR=""
fi
if [ -n "$LAUNCHER_BACKUP" ]; then
  rm -f "$LAUNCHER_BACKUP" || warn "Could not remove old launcher at $LAUNCHER_BACKUP"
  LAUNCHER_BACKUP=""
fi

# --- launcher -------------------------------------------------------------
say "Installed launcher → $BIN_DIR/komado"

# --- PATH check -----------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH. Add it, e.g.:  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc && source ~/.bashrc" ;;
esac

printf '\n\033[1;32m✓ komado installed.\033[0m  Launch it by typing:  \033[1mkomado\033[0m\n'

# --- Windows note ---------------------------------------------------------
# curl|bash on Windows runs under Git Bash/MSYS/Cygwin or WSL, so the launcher we
# just wrote is a *bash* script on the Unix PATH: usable inside this shell, but
# invisible to CMD/PowerShell (hence "'komado' is not recognized"). Steer those
# users to npm, which installs a native komado.cmd onto the Windows PATH.
on_windows=""
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) on_windows="$(uname -s)" ;;
  *) if grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then on_windows="WSL"; fi ;;
esac
if [ -n "$on_windows" ]; then
  printf '\n\033[1;33m! Windows detected (%s).\033[0m The command above works inside this shell, but NOT from CMD or PowerShell.\n' "$on_windows" >&2
  printf '  For a command you can run from CMD/PowerShell, install with npm there instead:\n' >&2
  printf '      \033[1mnpm i -g komado\033[0m\n' >&2
  printf '  ...or the PowerShell one-liner:\n' >&2
  printf '      \033[1mirm https://raw.githubusercontent.com/RyuPrad/komado/main/install.ps1 | iex\033[0m\n' >&2
fi

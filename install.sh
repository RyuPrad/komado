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

# --- preconditions --------------------------------------------------------
command -v git  >/dev/null 2>&1 || die "git is required."
command -v npm  >/dev/null 2>&1 || die "npm is required."
command -v node >/dev/null 2>&1 || die "Node.js >= 20 is required - see https://nodejs.org"
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$node_major" -ge 20 ] || die "Node.js >= 20 required (found $(node -v))."

if ! command -v chafa >/dev/null 2>&1; then
  hint="install chafa for the crisp pixel viewer"
  if   command -v apt    >/dev/null 2>&1; then hint="sudo apt install chafa"
  elif command -v brew   >/dev/null 2>&1; then hint="brew install chafa"
  elif command -v dnf    >/dev/null 2>&1; then hint="sudo dnf install chafa"
  elif command -v pacman >/dev/null 2>&1; then hint="sudo pacman -S chafa"
  fi
  warn "chafa not found - $hint  (without it, komado falls back to character-cell rendering)"
fi

# --- fetch / update -------------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  say "Updating komado in $APP_DIR"
  git -C "$APP_DIR" pull --ff-only --depth 1 \
    || { warn "update failed - re-cloning"; rm -rf "$APP_DIR"; git clone --depth 1 "$REPO" "$APP_DIR"; }
else
  say "Downloading komado → $APP_DIR"
  rm -rf "$APP_DIR"; mkdir -p "$(dirname "$APP_DIR")"
  git clone --depth 1 "$REPO" "$APP_DIR"
fi

# --- build ----------------------------------------------------------------
say "Installing dependencies and building (one-time, ~a minute)"
( cd "$APP_DIR" && npm install --no-audit --no-fund --loglevel=error )
# Runtime needs only `dependencies`; drop build/test tooling to slim the install.
( cd "$APP_DIR" && npm prune --omit=dev --no-audit --no-fund --loglevel=error >/dev/null 2>&1 || true )
[ -f "$APP_DIR/dist/cli.js" ] || die "build failed: $APP_DIR/dist/cli.js was not produced."

# --- launcher -------------------------------------------------------------
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/komado" <<EOF
#!/usr/bin/env bash
exec node "$APP_DIR/dist/cli.js" "\$@"
EOF
chmod +x "$BIN_DIR/komado"
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

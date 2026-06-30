# komado installer for Windows (PowerShell 5+).
#
#   irm https://raw.githubusercontent.com/RyuPrad/komado/main/install.ps1 | iex
#
# Installs komado globally with npm, which drops a native `komado` command on your
# PATH (usable from both PowerShell and CMD). Safe to re-run any time to update.
#
# Why npm and not the curl|bash installer? That one writes a *bash* launcher on the
# Unix PATH (Git Bash / WSL) which CMD and PowerShell can't see. npm installs a real
# komado.cmd on the Windows PATH, so `komado` just works.

function Info($m) { Write-Host "> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "x $m" -ForegroundColor Red }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js >= 20 is required. Install it from https://nodejs.org and re-run."
  return
}
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]" 2>$null)
if ($nodeMajor -lt 20) {
  Fail "Node.js >= 20 required (found $(node -v))."
  return
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Fail "npm is required (it ships with Node.js)."
  return
}

Info "Installing komado globally (npm i -g komado) ..."
npm install -g komado
if ($LASTEXITCODE -ne 0) {
  Fail "npm install failed - see the npm output above."
  return
}

if (-not (Get-Command chafa -ErrorAction SilentlyContinue)) {
  Warn "chafa not found - komado will use character-cell rendering. For the crisp pixel viewer, install chafa (https://hpjansson.org/chafa/) and use a sixel-capable terminal (e.g. recent Windows Terminal)."
}

Write-Host ""
Write-Host "komado installed. Launch it by typing:  komado" -ForegroundColor Green

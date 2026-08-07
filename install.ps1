# komado installer for Windows (Windows PowerShell 5.1+).
#
#   irm https://raw.githubusercontent.com/RyuPrad/komado/main/install.ps1 | iex
#
# Ensures Node.js >= 20 is present (installs the LTS via winget if not), then
# installs komado globally with npm, then keeps the native `komado.cmd` launcher and
# removes npm's PowerShell shim. Safe to re-run any time to update.
#
# Why npm and not the curl|bash installer? That one writes a *bash* launcher on the
# Unix PATH (Git Bash / WSL) which CMD and PowerShell can't see. npm installs a real
# komado.cmd on the Windows PATH, so `komado` just works.
#
# Works even under PowerShell's Restricted execution policy: it calls npm via
# npm.cmd (a batch file, not policy-gated) and removes npm's generated komado.ps1,
# which PowerShell would otherwise prefer over komado.cmd and refuse to load.

function Info($m) { Write-Host "> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "x $m" -ForegroundColor Red }

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# Re-read the machine + user PATH into this session, so a Node we just installed is
# found without the user having to close and reopen the terminal.
function Sync-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Get-NodeMajor {
  if (-not (Have node)) { return 0 }
  try { return [int](node -p "process.versions.node.split('.')[0]" 2>$null) } catch { return 0 }
}

function Get-NpmMajor($npm) {
  try {
    $version = (& $npm --version 2>$null | Select-Object -Last 1).Trim()
    return [int]($version.Split('.')[0])
  } catch {
    return 0
  }
}

$nodeMajor = Get-NodeMajor
if ($nodeMajor -lt 20) {
  if ($nodeMajor -gt 0) { Warn "Node $(node -v) found, but komado needs >= 20 - installing the latest LTS..." }
  else                  { Info "Node.js not found - installing the LTS via winget..." }

  if (Have winget) {
    winget install --id OpenJS.NodeJS.LTS -e --source winget --silent --accept-source-agreements --accept-package-agreements
    Sync-Path
    $nodeMajor = Get-NodeMajor
  } else {
    Fail "winget isn't available on this PC. Install Node.js >= 20 from https://nodejs.org , then re-run this command."
    return
  }
}

if ($nodeMajor -lt 20) {
  Fail "Couldn't set up Node.js >= 20 automatically. Install it from https://nodejs.org (or run: winget install OpenJS.NodeJS.LTS), reopen your terminal, then re-run this installer."
  return
}

# Call npm via its .cmd shim. Bare `npm` in PowerShell resolves to npm.ps1, which
# the default Restricted execution policy refuses to load - and the thrown error
# leaves $LASTEXITCODE stale, so a `npm install` that never ran would otherwise
# look like success (https://github.com/RyuPrad/komado). npm.cmd is a batch file
# (not policy-gated) and always sets a reliable exit code.
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) {
  Fail "Node is installed but npm.cmd isn't on PATH yet. Close and reopen your terminal, then re-run this command."
  return
}

$npmMajor = Get-NpmMajor $npm
if ($npmMajor -ge 11) {
  # npm 11+ blocks dependency install scripts unless explicitly approved. sharp's
  # install/check script validates its native image backend, so approve only sharp
  # for this one install rather than weakening the user's npm configuration.
  Info "Installing komado globally (npm i -g --allow-scripts=sharp komado) ..."
  & $npm install -g --allow-scripts=sharp komado
} else {
  Info "Installing komado globally (npm i -g komado) ..."
  & $npm install -g komado
}
if ($LASTEXITCODE -ne 0) {
  Fail "npm install failed - see the npm output above."
  return
}

# npm creates both komado.cmd and komado.ps1 on Windows. Under Restricted policy,
# PowerShell resolves bare `komado` to the .ps1 shim first and rejects it before the
# working .cmd shim can run. Remove only npm's generated PowerShell shim; this keeps
# the launch command native to both PowerShell and CMD without changing policy.
$npmPrefix = (& $npm prefix -g 2>$null | Select-Object -Last 1).Trim()
if (-not $npmPrefix) {
  Fail "npm installed komado, but its global prefix could not be determined."
  return
}

$cmdShim = Join-Path $npmPrefix 'komado.cmd'
$psShim  = Join-Path $npmPrefix 'komado.ps1'
if (-not (Test-Path -LiteralPath $cmdShim -PathType Leaf)) {
  Fail "npm installed komado, but the Windows launcher was not found at $cmdShim"
  return
}

if (Test-Path -LiteralPath $psShim -PathType Leaf) {
  try {
    Remove-Item -LiteralPath $psShim -Force -ErrorAction Stop
  } catch {
    Fail "komado was installed, but PowerShell's generated shim could not be removed: $psShim"
    Write-Host "  You can still launch it explicitly with:  komado.cmd" -ForegroundColor Yellow
    return
  }
}

# Trust presence and execution, not just npm's exit code. This catches a missing
# global PATH and native dependency failures before we claim the install succeeded.
Sync-Path
if (-not (Have komado.cmd)) {
  Write-Host ""
  Fail "npm finished, but 'komado.cmd' isn't on your PATH."
  Write-Host "  This usually means npm's global bin just needs a PATH refresh:" -ForegroundColor Yellow
  Write-Host "  open a NEW terminal and run 'komado'." -ForegroundColor Yellow
  Write-Host "  (npm's global prefix is: $npmPrefix)" -ForegroundColor DarkGray
  return
}

& $cmdShim --version *> $null
if ($LASTEXITCODE -ne 0) {
  Fail "komado installed, but its launcher could not start successfully."
  Write-Host "  Try running 'komado.cmd --version' to see the underlying error." -ForegroundColor Yellow
  return
}

if (-not (Have chafa)) {
  Warn "chafa not found - komado will use character-cell rendering. For the crisp pixel viewer, install chafa (https://hpjansson.org/chafa/) and use a sixel-capable terminal (e.g. recent Windows Terminal)."
}

Write-Host ""
Write-Host "komado installed. Launch it by typing:  komado" -ForegroundColor Green
Write-Host "PowerShell execution policy was not changed." -ForegroundColor DarkGray
Write-Host "(If 'komado' isn't found, open a new terminal so PATH refreshes.)" -ForegroundColor DarkGray

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../install.ps1', import.meta.url));

function windowsPowerShell() {
  for (const command of ['powershell.exe', 'powershell', 'pwsh']) {
    const result = spawnSync(command, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf8',
    });
    if (!result.error && result.status === 0) return command;
  }
  return null;
}

describe('install.ps1', () => {
  it('uses policy-safe npm and launcher shims', () => {
    const source = fs.readFileSync(installer, 'utf8');

    expect(source).toContain('Get-Command npm.cmd');
    expect(source).toContain('--allow-scripts=sharp');
    expect(source).toContain("Join-Path $npmPrefix 'komado.cmd'");
    expect(source).toContain("Join-Path $npmPrefix 'komado.ps1'");
    expect(source).toContain('Remove-Item -LiteralPath $psShim');
    expect(source).toContain('& $cmdShim --version');
    expect(source).not.toMatch(/Set-ExecutionPolicy/i);
  });

  it('parses in Windows PowerShell when available', () => {
    const command = windowsPowerShell();
    if (!command) return;

    const result = spawnSync(command, [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      '$source=[Console]::In.ReadToEnd(); $tokens=$null; $errors=$null; ' +
        '[System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors) | Out-Null; ' +
        'if($errors.Count){$errors | ForEach-Object { Write-Error $_.Message }; exit 1}',
    ], {
      input: fs.readFileSync(installer, 'utf8'),
      encoding: 'utf8',
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('lets bare komado resolve to the cmd shim under Restricted policy', () => {
    const command = windowsPowerShell();
    if (!command) return;

    const script = [
      '$ErrorActionPreference="Stop"',
      '$d=Join-Path $env:TEMP ("komado-policy-test-"+[guid]::NewGuid().ToString("N"))',
      'New-Item -ItemType Directory -Path $d | Out-Null',
      'try {',
      '  Set-Content -LiteralPath (Join-Path $d "komado.cmd") -Value "@echo off`r`necho CMD_OK" -Encoding Ascii',
      '  Set-Content -LiteralPath (Join-Path $d "komado.ps1") -Value "Write-Output PS1_OK" -Encoding Ascii',
      '  $env:PATH=$d+";"+$env:PATH',
      '  if(-not (Get-Command komado).Source.EndsWith("komado.ps1", [System.StringComparison]::OrdinalIgnoreCase)){throw "expected PowerShell shim to win before cleanup"}',
      '  $blocked=$false',
      '  try { komado | Out-Null } catch [System.Management.Automation.PSSecurityException] { $blocked=$true }',
      '  if(-not $blocked){throw "expected Restricted policy to block komado.ps1"}',
      '  Remove-Item -LiteralPath (Join-Path $d "komado.ps1") -Force',
      '  if(-not (Get-Command komado).Source.EndsWith("komado.cmd", [System.StringComparison]::OrdinalIgnoreCase)){throw "expected cmd shim after cleanup"}',
      '  $out=(& komado.cmd | Select-Object -Last 1).Trim()',
      '  if($out -ne "CMD_OK"){throw "cmd shim did not run"}',
      '} finally { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue }',
    ].join('; ');

    const result = spawnSync(command, [
      '-NoProfile',
      '-ExecutionPolicy', 'Restricted',
      '-Command', script,
    ], { encoding: 'utf8' });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});

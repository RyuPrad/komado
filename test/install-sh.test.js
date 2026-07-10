import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../install.sh', import.meta.url));

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

describe('install.sh', () => {
  let root;
  let appDir;
  let binDir;
  let fakeBin;
  let fakeRepo;
  let commandLog;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'komado-install-'));
    appDir = path.join(root, 'share', 'komado');
    binDir = path.join(root, 'bin');
    fakeBin = path.join(root, 'fake-bin');
    fakeRepo = path.join(root, 'repository');
    commandLog = path.join(root, 'commands.log');

    fs.mkdirSync(path.join(fakeRepo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(fakeRepo, 'package.json'), JSON.stringify({ name: 'komado' }));
    fs.writeFileSync(path.join(fakeRepo, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(fakeRepo, 'release-marker'), 'new release');
    fs.mkdirSync(fakeBin, { recursive: true });

    writeExecutable(path.join(fakeBin, 'git'), `#!/bin/sh
set -eu
printf 'git|%s\n' "$*" >> "$FAKE_LOG"
[ "$1" != -C ] || {
  cd "$2"
  if [ "\${4:-}" = --show-prefix ]; then printf '\n'; else pwd -P; fi
  exit 0
}
[ "$1" = clone ] || exit 64
if [ "\${FAKE_GIT_FAIL:-}" = 1 ]; then
  printf 'simulated git failure\n' >&2
  exit 43
fi
for arg do dest=$arg; done
cp -R "$FAKE_REPO/." "$dest"
`);
    writeExecutable(path.join(fakeBin, 'npm'), `#!/bin/sh
set -eu
printf 'npm|%s|%s\n' "$PWD" "$*" >> "$FAKE_LOG"
if [ "\${FAKE_NPM_FAIL:-}" = 1 ] && [ "$1" != prune ]; then
  printf 'simulated npm failure\n' >&2
  exit 42
fi
if [ "\${FAKE_PRUNE_FAIL:-}" = 1 ] && [ "$1" = prune ]; then
  printf 'simulated prune failure\n' >&2
  exit 44
fi
case "$1" in
  ci|install)
    mkdir -p dist
    printf '#!/usr/bin/env node\n' > dist/cli.js
    ;;
esac
`);
    writeExecutable(path.join(fakeBin, 'mv'), `#!/bin/sh
set -eu
if [ "\${FAKE_ACTIVATE_FAIL:-}" = 1 ] && [ "$2" = "$KOMADO_APP_DIR" ]; then
  case "$1" in *.tmp.*) printf 'simulated activation failure\n' >&2; exit 45 ;; esac
fi
exec /bin/mv "$@"
`);
    writeExecutable(path.join(fakeBin, 'chafa'), '#!/bin/sh\nexit 0\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function run(extraEnv = {}) {
    return spawnSync('bash', [installer], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: path.join(root, 'home'),
        PATH: `${fakeBin}:${process.env.PATH}`,
        KOMADO_REPO: fakeRepo,
        KOMADO_APP_DIR: appDir,
        KOMADO_BIN_DIR: binDir,
        FAKE_REPO: fakeRepo,
        FAKE_LOG: commandLog,
        ...extraEnv,
      },
    });
  }

  function makeExistingInstall() {
    fs.mkdirSync(path.join(appDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'komado' }));
    fs.writeFileSync(path.join(appDir, 'release-marker'), 'old release');
  }

  function siblingArtifacts() {
    const parent = path.dirname(appDir);
    if (!fs.existsSync(parent)) return [];
    return fs.readdirSync(parent).filter((name) => /^komado\.(tmp|backup)\./.test(name));
  }

  it('builds with npm ci in staging and atomically installs the result', () => {
    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(appDir, 'release-marker'), 'utf8')).toBe('new release');
    expect(fs.existsSync(path.join(appDir, 'dist', 'cli.js'))).toBe(true);
    expect(fs.readFileSync(path.join(binDir, 'komado'), 'utf8')).toContain(`${appDir}/dist/cli.js`);
    const log = fs.readFileSync(commandLog, 'utf8');
    expect(log).toContain('npm|');
    expect(log).toContain('|ci --no-audit --no-fund --loglevel=error');
    expect(log).not.toContain('|install --no-audit');
    expect(siblingArtifacts()).toEqual([]);
  });

  it('swaps a valid existing checkout only after the replacement builds', () => {
    makeExistingInstall();

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(appDir, 'release-marker'), 'utf8')).toBe('new release');
    expect(siblingArtifacts()).toEqual([]);
  });

  it('leaves the existing checkout untouched when the staged build fails', () => {
    makeExistingInstall();

    const result = run({ FAKE_NPM_FAIL: '1' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('simulated npm failure');
    expect(fs.readFileSync(path.join(appDir, 'release-marker'), 'utf8')).toBe('old release');
    expect(siblingArtifacts()).toEqual([]);
  });

  it('leaves the existing checkout untouched when dependency pruning fails', () => {
    makeExistingInstall();

    const result = run({ FAKE_PRUNE_FAIL: '1' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('simulated prune failure');
    expect(fs.readFileSync(path.join(appDir, 'release-marker'), 'utf8')).toBe('old release');
    expect(siblingArtifacts()).toEqual([]);
  });

  it('leaves the existing checkout untouched when downloading the update fails', () => {
    makeExistingInstall();

    const result = run({ FAKE_GIT_FAIL: '1' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('simulated git failure');
    expect(fs.readFileSync(path.join(appDir, 'release-marker'), 'utf8')).toBe('old release');
    expect(siblingArtifacts()).toEqual([]);
  });

  it('leaves the existing checkout untouched when the launcher target is invalid', () => {
    makeExistingInstall();
    fs.mkdirSync(path.join(binDir, 'komado'), { recursive: true });

    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('it is a directory');
    expect(fs.readFileSync(path.join(appDir, 'release-marker'), 'utf8')).toBe('old release');
  });

  it('rolls the existing checkout back when activation fails', () => {
    makeExistingInstall();
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'komado'), 'previous launcher');

    const result = run({ FAKE_ACTIVATE_FAIL: '1' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('simulated activation failure');
    expect(fs.readFileSync(path.join(appDir, 'release-marker'), 'utf8')).toBe('old release');
    expect(fs.readFileSync(path.join(binDir, 'komado'), 'utf8')).toBe('previous launcher');
    expect(siblingArtifacts()).toEqual([]);
  });

  it('removes a newly-created launcher when fresh activation fails', () => {
    const result = run({ FAKE_ACTIVATE_FAIL: '1' });

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(appDir)).toBe(false);
    expect(fs.existsSync(path.join(binDir, 'komado'))).toBe(false);
    expect(siblingArtifacts()).toEqual([]);
  });

  it('restores a dangling launcher symlink when activation fails', () => {
    makeExistingInstall();
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync('/missing/old-komado', path.join(binDir, 'komado'));

    const result = run({ FAKE_ACTIVATE_FAIL: '1' });

    expect(result.status).not.toBe(0);
    expect(fs.readlinkSync(path.join(binDir, 'komado'))).toBe('/missing/old-komado');
    expect(fs.readFileSync(path.join(appDir, 'release-marker'), 'utf8')).toBe('old release');
  });

  it('rejects a nested bin directory without creating the application target', () => {
    const result = run({ KOMADO_BIN_DIR: path.join(appDir, 'bin') });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must be outside KOMADO_APP_DIR');
    expect(fs.existsSync(appDir)).toBe(false);
    expect(fs.existsSync(commandLog)).toBe(false);
  });

  it('refuses to replace an unrelated non-empty target', () => {
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'keep-me'), 'personal data');

    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('it is not a komado git checkout');
    expect(fs.readFileSync(path.join(appDir, 'keep-me'), 'utf8')).toBe('personal data');
    expect(fs.existsSync(commandLog)).toBe(false);
  });

  it('falls back to npm install when the repository has no lockfile', () => {
    fs.rmSync(path.join(fakeRepo, 'package-lock.json'));

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    const log = fs.readFileSync(commandLog, 'utf8');
    expect(log).toContain('|install --no-audit --no-fund --loglevel=error');
  });
});

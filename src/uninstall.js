import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { paths } from './config.js';
import { disablePersistence } from './state/store.js';

// Where install.sh put things. Mirrors the installer's own defaults + env
// overrides (KOMADO_APP_DIR / KOMADO_BIN_DIR) so an in-app uninstall targets
// exactly what was installed - and never a dev checkout, which lives elsewhere.
function appDir() {
  if (process.env.KOMADO_APP_DIR) return path.resolve(process.env.KOMADO_APP_DIR);
  const share = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(share, 'komado');
}
function launcherFile() {
  const bin = process.env.KOMADO_BIN_DIR
    ? path.resolve(process.env.KOMADO_BIN_DIR)
    : path.join(os.homedir(), '.local', 'bin');
  // The launcher FILE only - never the whole bin dir, which is shared with other tools.
  return path.join(bin, 'komado');
}

// The three things a full install creates. `paths.home` is the runtime data dir
// (~/.komado or KOMADO_HOME) and holds config, reading progress, the MangaDex
// login, the page cache, and the log - all under one dir, so one delete clears it.
export function uninstallTargets() {
  return [
    { label: 'application files', path: appDir() },
    { label: 'launcher', path: launcherFile() },
    { label: 'config, reading progress & MangaDex login', path: paths.home },
  ];
}

// $HOME → ~ for display.
export function displayPath(p) {
  const home = os.homedir();
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

// Defensive: a recursive force-delete must never escape to a filesystem or home
// root, however the paths above were derived.
function assertSafe(p) {
  const resolved = path.resolve(p);
  if (!resolved || resolved === path.parse(resolved).root || resolved === os.homedir()) {
    throw new Error(`refusing to delete unsafe path: ${resolved}`);
  }
}

// Remove the installed app, its launcher, and all runtime data. Synchronous - a
// one-shot teardown run right before exit. It first switches off the store's
// persistence so a pending debounced save (or the flushProgress() that quit()
// runs) can't recreate the data dir we're deleting. One failing target never
// aborts the rest; returns a per-target status list for the goodbye summary.
export function performUninstall() {
  disablePersistence();
  return uninstallTargets().map((t) => {
    try {
      assertSafe(t.path);
      const existed = fs.existsSync(t.path);
      fs.rmSync(t.path, { recursive: true, force: true });
      return { ...t, status: existed ? 'removed' : 'absent' };
    } catch (err) {
      return { ...t, status: 'failed', error: err.message };
    }
  });
}

export function formatUninstallSummary(results) {
  const ok = results.every((r) => r.status !== 'failed');
  const tag = { removed: 'removed', absent: 'absent ', failed: 'FAILED ' };
  const lines = results.map((r) => `  ${tag[r.status]}  ${displayPath(r.path)}${r.error ? `  (${r.error})` : ''}`);
  const head = ok ? 'komado has been uninstalled.' : 'komado uninstall finished with errors.';
  return [head, '', ...lines, ''].join('\n');
}

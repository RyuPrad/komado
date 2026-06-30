import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Self-contained runtime home. Override with KOMADO_HOME (handy for tests).
const usingDefaultHome = !process.env.KOMADO_HOME;
const HOME = usingDefaultHome
  ? path.join(os.homedir(), '.komado')
  : path.resolve(process.env.KOMADO_HOME);
// The pre-rename home (the project used to be "manga-tui") - migrated once on
// first run so existing config / reading progress / MangaDex login carry over.
const LEGACY_HOME = path.join(os.homedir(), '.manga-tui');

export const paths = {
  home: HOME,
  configFile: path.join(HOME, 'config.json'),
  progressFile: path.join(HOME, 'progress.json'),
  credentialsFile: path.join(HOME, 'credentials.json'),
  cacheDir: path.join(HOME, 'cache'),
  logFile: path.join(HOME, 'komado.log'),
};

export function ensureDirs() {
  // One-time migration from the old ~/.manga-tui home so saved state isn't
  // orphaned. Best-effort, default-home only (same filesystem → rename suffices).
  if (usingDefaultHome && !fs.existsSync(HOME) && fs.existsSync(LEGACY_HOME)) {
    try { fs.renameSync(LEGACY_HOME, HOME); } catch { /* leave the legacy dir as-is */ }
  }
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.cacheDir, { recursive: true });
}

export const DEFAULT_CONFIG = {
  localLibraryPaths: [],   // directories scanned by the local source
  language: 'en',          // preferred MangaDex translatedLanguage
  contentRating: ['safe', 'suggestive'],
  dataSaver: true,         // smaller MangaDex page images - ideal for a terminal
  renderer: 'auto',        // auto | halfblock | chafa
  theme: 'default',
  syncProgress: true,      // push read-markers to MangaDex while logged in
};

export const MANGADEX = {
  api: 'https://api.mangadex.org',
  auth: 'https://auth.mangadex.org/realms/mangadex/protocol/openid-connect/token',
  uploads: 'https://uploads.mangadex.org',
  userAgent: 'komado/0.1 (+https://github.com/RyuPrad/komado)',
  pageLimit: 20,
};

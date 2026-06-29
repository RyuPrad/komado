import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Self-contained runtime home. Override with MANGA_TUI_HOME (handy for tests).
const HOME = process.env.MANGA_TUI_HOME
  ? path.resolve(process.env.MANGA_TUI_HOME)
  : path.join(os.homedir(), '.manga-tui');

export const paths = {
  home: HOME,
  configFile: path.join(HOME, 'config.json'),
  progressFile: path.join(HOME, 'progress.json'),
  credentialsFile: path.join(HOME, 'credentials.json'),
  cacheDir: path.join(HOME, 'cache'),
  logFile: path.join(HOME, 'manga-tui.log'),
};

export function ensureDirs() {
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.cacheDir, { recursive: true });
}

export const DEFAULT_CONFIG = {
  localLibraryPaths: [],   // directories scanned by the local source
  language: 'en',          // preferred MangaDex translatedLanguage
  contentRating: ['safe', 'suggestive'],
  dataSaver: true,         // smaller MangaDex page images — ideal for a terminal
  renderer: 'auto',        // auto | halfblock | chafa
  theme: 'default',
  syncProgress: true,      // push read-markers to MangaDex while logged in
};

export const MANGADEX = {
  api: 'https://api.mangadex.org',
  auth: 'https://auth.mangadex.org/realms/mangadex/protocol/openid-connect/token',
  uploads: 'https://uploads.mangadex.org',
  userAgent: 'manga-tui/0.1 (+https://github.com/RyuPrad/manga-tui)',
  pageLimit: 20,
};

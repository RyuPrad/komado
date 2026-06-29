import fs from 'node:fs';
import { paths, DEFAULT_CONFIG, ensureDirs } from '../config.js';
import { logger } from '../lib/logger.js';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`failed to read ${file}`, err);
    return fallback;
  }
}

// Write-to-temp + rename so a crash mid-write never corrupts the file.
function writeJsonAtomic(file, data) {
  ensureDirs();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---- Config (user prefs + library paths) -------------------------------
let config = null;
export function getConfig() {
  if (!config) config = { ...DEFAULT_CONFIG, ...readJson(paths.configFile, {}) };
  return config;
}
export function setConfig(patch) {
  config = { ...getConfig(), ...patch };
  writeJsonAtomic(paths.configFile, config);
  return config;
}

// ---- Reading progress --------------------------------------------------
// Shape: { [mangaKey]: { source, mangaId, mangaTitle, chapterId, chapterNumber, page, updatedAt } }
let progress = null;
function loadProgress() {
  if (!progress) progress = readJson(paths.progressFile, {});
  return progress;
}

// Debounced save — the reader updates progress on every page turn, so coalesce.
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJsonAtomic(paths.progressFile, progress), 400);
  saveTimer.unref?.();
}

export function getProgress(mangaKey) {
  return loadProgress()[mangaKey] || null;
}
export function getAllProgress() {
  return Object.values(loadProgress()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
export function setProgress(mangaKey, entry) {
  loadProgress()[mangaKey] = { ...entry, updatedAt: Date.now() };
  scheduleSave();
}
export function flushProgress() {
  clearTimeout(saveTimer);
  if (progress) writeJsonAtomic(paths.progressFile, progress);
}

// ---- MangaDex credentials (OAuth2 personal client) ---------------------
// Only the durable secrets live here: the client id/secret and the rotating
// refresh token. The 15-min access token is kept in memory by auth.js and
// never written to disk. File is 0600 since it holds a long-lived secret.
let credentials = null;
function writeCredentialsAtomic(data) {
  ensureDirs();
  const file = paths.credentialsFile;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort (e.g. Windows) */ }
}
export function getCredentials() {
  if (credentials === null) credentials = readJson(paths.credentialsFile, {});
  return credentials.refreshToken ? credentials : null;
}
export function setCredentials(next) {
  credentials = { ...next };
  writeCredentialsAtomic(credentials);
  return credentials;
}
export function clearCredentials() {
  credentials = {};
  try { fs.rmSync(paths.credentialsFile, { force: true }); } catch { /* ignore */ }
}

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { paths } from '../config.js';
import { getConfig, isPersistenceDisabled } from './store.js';
import { logger } from '../lib/logger.js';

// On-disk cache of remote page images, so a chapter read once isn't downloaded
// again in a later session. Keys come from the source and must name the image
// itself - never a URL carrying a short-lived token - and files are named by a
// hash of the key. Past the configured cap, least-recently-read files go first.

const MB = 1024 * 1024;
const capBytes = () => Math.max(0, Number(getConfig().pageCacheMB) || 0) * MB;
const enabled = () => capBytes() > 0 && !isPersistenceDisabled();
const fileFor = (key) => path.join(paths.pageCacheDir, `${createHash('sha256').update(key).digest('hex')}.img`);

// Only real images go in or come out, so a foreign or damaged file can't turn
// into a permanent decode error: JPEG, PNG, GIF and WebP (what MangaDex serves).
function looksLikeImage(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.readUInt32BE(0) === 0x89504e47) return true;
  if (buf.toString('latin1', 0, 4) === 'GIF8') return true;
  return buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
}

export async function readCachedPage(key) {
  if (!key || !enabled()) return null;
  const file = fileFor(key);
  let buf;
  try {
    buf = await fsp.readFile(file);
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('page cache read failed', err);
    return null;
  }
  if (!looksLikeImage(buf)) {
    fsp.rm(file, { force: true }).catch(() => {});
    return null;
  }
  const now = new Date();
  fsp.utimes(file, now, now).catch(() => {}); // recency for eviction
  logger.debug(`page cache hit ${key}`);
  return buf;
}

let writtenSinceSweep = 0;
let swept = false;

// Fire-and-forget. The write happens off the caller's path, but synchronously
// once it starts: performUninstall() is synchronous too, so a cache write can
// never interleave with it and recreate the data directory it is deleting.
export function writeCachedPage(key, buf) {
  if (!key || !enabled() || !looksLikeImage(buf)) return;
  setImmediate(() => {
    if (!enabled()) return;
    const file = fileFor(key);
    const tmp = `${file}.${process.pid}.tmp`; // rename makes a reader see all or nothing
    try {
      fs.mkdirSync(paths.pageCacheDir, { recursive: true });
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      logger.warn('page cache write failed', err);
      return;
    }
    // Sweep once per process (a lowered cap applies on the next read session),
    // then after every 1/16 of the cap written (at least 8MB).
    writtenSinceSweep += buf.length;
    if (!swept || writtenSinceSweep >= Math.max(8 * MB, capBytes() / 16)) {
      swept = true;
      writtenSinceSweep = 0;
      sweepPageCache().catch((err) => logger.warn('page cache sweep failed', err));
    }
  });
}

// Bring the cache under its cap: least-recently-read files go first, down to
// 90% so the next few writes don't each trigger another sweep. Temp files a
// crash left behind are removed after an hour.
export async function sweepPageCache({ cap = capBytes() } = {}) {
  let names;
  try {
    names = await fsp.readdir(paths.pageCacheDir);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  const entries = [];
  for (const name of names) {
    const file = path.join(paths.pageCacheDir, name);
    const st = await fsp.stat(file).catch(() => null);
    if (!st?.isFile()) continue;
    if (name.endsWith('.tmp')) {
      if (Date.now() - st.mtimeMs > 60 * 60 * 1000) await fsp.rm(file, { force: true }).catch(() => {});
      continue;
    }
    entries.push({ file, size: st.size, mtime: st.mtimeMs });
  }
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  if (total <= cap) return;
  entries.sort((a, b) => a.mtime - b.mtime);
  for (const e of entries) {
    if (total <= cap * 0.9) break;
    await fsp.rm(e.file, { force: true }).catch(() => {});
    total -= e.size;
  }
}

export async function pageCacheStats() {
  let files = 0;
  let bytes = 0;
  let names = [];
  try {
    names = await fsp.readdir(paths.pageCacheDir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const name of names) {
    if (name.endsWith('.tmp')) continue;
    const st = await fsp.stat(path.join(paths.pageCacheDir, name)).catch(() => null);
    if (st?.isFile()) {
      files += 1;
      bytes += st.size;
    }
  }
  return { files, bytes };
}

export function clearPageCache() {
  try {
    fs.rmSync(paths.pageCacheDir, { recursive: true, force: true });
  } catch (err) {
    logger.warn('page cache clear failed', err);
  }
}

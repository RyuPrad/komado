import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

// Real files under a throwaway KOMADO_HOME. config.js reads KOMADO_HOME at
// import, so every test re-evaluates the modules against its own directory.
let root;
let oldHome;
let store;
let cache;
let cacheDir;

const image = (r) => sharp({ create: { width: 8, height: 8, channels: 3, background: { r, g: 0, b: 0 } } })
  .png().toBuffer();
const writesSettle = () => new Promise((resolve) => setImmediate(resolve)); // writes run on setImmediate
const cachedFiles = () => (fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []);

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'komado-page-cache-'));
  oldHome = process.env.KOMADO_HOME;
  process.env.KOMADO_HOME = root;
  vi.resetModules();
  store = await import('../src/state/store.js');
  cache = await import('../src/state/pageCache.js');
  cacheDir = (await import('../src/config.js')).paths.pageCacheDir;
});

afterEach(() => {
  vi.doUnmock('../src/sources/mangadex/client.js');
  vi.doUnmock('../src/sources/mangadex/auth.js');
  vi.doUnmock('../src/lib/fetchWithBackoff.js');
  if (oldHome === undefined) delete process.env.KOMADO_HOME;
  else process.env.KOMADO_HOME = oldHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('page cache', () => {
  it('serves a written page, including after a restart', async () => {
    const png = await image(10);
    cache.writeCachedPage('k1', png);
    await writesSettle();
    expect((await cache.readCachedPage('k1')).equals(png)).toBe(true);

    vi.resetModules();
    const fresh = await import('../src/state/pageCache.js');
    expect((await fresh.readCachedPage('k1')).equals(png)).toBe(true);
    expect(await fresh.readCachedPage('missing')).toBeNull();
  });

  it('only stores real images and drops a damaged entry', async () => {
    cache.writeCachedPage('text', Buffer.from('<html>error page</html>'));
    await writesSettle();
    expect(cachedFiles()).toEqual([]);

    cache.writeCachedPage('k1', await image(20));
    await writesSettle();
    const [name] = cachedFiles();
    fs.writeFileSync(path.join(cacheDir, name), 'truncated garbage');
    expect(await cache.readCachedPage('k1')).toBeNull();
    await vi.waitFor(() => expect(cachedFiles()).toEqual([]));
  });

  it('does nothing when the cap is 0', async () => {
    const png = await image(30);
    cache.writeCachedPage('k1', png);
    await writesSettle();
    store.setConfig({ pageCacheMB: 0 });
    expect(await cache.readCachedPage('k1')).toBeNull();
    cache.writeCachedPage('k2', png);
    await writesSettle();
    expect(cachedFiles()).toHaveLength(1);
  });

  it('cannot recreate the data directory once uninstall disabled persistence', async () => {
    cache.writeCachedPage('k1', await image(40)); // queued before the uninstall starts
    store.disablePersistence();
    fs.rmSync(root, { recursive: true, force: true });
    await writesSettle();
    expect(fs.existsSync(root)).toBe(false);
  });

  it('evicts the least recently read pages and stale temp files', async () => {
    const fileOf = (key) => path.join(cacheDir, `${createHash('sha256').update(key).digest('hex')}.img`);
    const size = (key) => fs.statSync(fileOf(key)).size;
    for (const [key, r] of [['a', 50], ['b', 60], ['c', 70]]) cache.writeCachedPage(key, await image(r));
    await writesSettle();
    // Age them a, b, c (oldest first), then read a: b becomes the least recently read.
    for (const [key, secondsAgo] of [['a', 300], ['b', 200], ['c', 100]]) {
      const t = new Date(Date.now() - secondsAgo * 1000);
      fs.utimesSync(fileOf(key), t, t);
    }
    await cache.readCachedPage('a');
    await vi.waitFor(() => expect(fs.statSync(fileOf('a')).mtimeMs).toBeGreaterThan(Date.now() - 60_000));

    const oldTmp = path.join(cacheDir, 'x.img.1.tmp');
    const newTmp = path.join(cacheDir, 'y.img.2.tmp');
    fs.writeFileSync(oldTmp, 'partial');
    fs.writeFileSync(newTmp, 'in progress');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    fs.utimesSync(oldTmp, twoHoursAgo, twoHoursAgo);

    // One byte over the cap: evict oldest-read first, down to 90% of it.
    await cache.sweepPageCache({ cap: size('a') + size('b') + size('c') - 1 });
    expect(fs.existsSync(fileOf('a'))).toBe(true);
    expect(fs.existsSync(fileOf('b'))).toBe(false);
    expect(fs.existsSync(fileOf('c'))).toBe(true);
    expect(fs.existsSync(oldTmp)).toBe(false);
    expect(fs.existsSync(newTmp)).toBe(true);
    expect(await cache.pageCacheStats()).toEqual({ files: 2, bytes: size('a') + size('c') });

    cache.clearPageCache();
    expect(fs.existsSync(cacheDir)).toBe(false);
    expect(await cache.pageCacheStats()).toEqual({ files: 0, bytes: 0 });
  });
});

describe('MangaDex pages on disk', () => {
  async function loadSource({ handouts, fetch }) {
    vi.doMock('../src/sources/mangadex/client.js', () => ({
      mdGet: vi.fn(async () => handouts.shift()),
      mdSend: vi.fn(),
    }));
    vi.doMock('../src/sources/mangadex/auth.js', () => ({
      isLoggedIn: () => false,
      getSessionGeneration: () => 0,
    }));
    vi.doMock('../src/lib/fetchWithBackoff.js', () => ({ fetchWithBackoff: fetch, fetchJson: vi.fn() }));
    return import('../src/sources/mangadex/index.js');
  }
  const handout = (base) => ({
    baseUrl: base,
    chapter: { hash: 'h1', data: ['p0.png'], dataSaver: ['s0.png'] },
  });

  it('keys pages by image, not by at-home node, and skips the download on a hit', async () => {
    const png = await image(90);
    const fetch = vi.fn(async () => ({ ok: true, arrayBuffer: async () => png }));
    const md = await loadSource({ handouts: [handout('https://node-a'), handout('https://node-b')], fetch });

    const [first] = await md.getPages('ch1');
    expect((await md.loadPageBuffer(first)).equals(png)).toBe(true);
    await writesSettle();

    const [second] = await md.getPages('ch1', { fresh: true }); // a new handout, new node + token
    expect(second.url).not.toBe(first.url);
    expect(second.cacheKey).toBe(first.cacheKey);
    expect(first.cacheKey).toBe('mangadex/data-saver/h1/s0.png');
    expect((await md.loadPageBuffer(second)).equals(png)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never caches a failed download', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 404, body: { cancel: async () => {} } }));
    const md = await loadSource({ handouts: [handout('https://node-a'), handout('https://node-b')], fetch });
    const [page] = await md.getPages('ch1');
    await expect(md.loadPageBuffer(page)).rejects.toThrow(/404/);
    await writesSettle();
    expect(cachedFiles()).toEqual([]);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import { setConfig } from '../src/state/store.js';
import * as local from '../src/sources/local/index.js';

// Detect the rar creator at collection time so the CBR case can be skipped on CI.
let hasRar = false;
try {
  execSync('command -v rar', { stdio: 'ignore' });
  hasRar = true;
} catch {
  /* rar not installed - CBR test skipped */
}

const fixtures = path.join(os.tmpdir(), `komado-local-test-${process.pid}`);
const png = (rgb) => sharp({ create: { width: 40, height: 60, channels: 3, background: rgb } }).png().toBuffer();
const PAGES = ['1.png', '2.png', '10.png']; // 10 last → exercises natural sort

beforeAll(async () => {
  fs.rmSync(fixtures, { recursive: true, force: true });

  // folder-manga with one image-folder chapter
  const folderCh = path.join(fixtures, 'Folder Manga', 'Chapter 1');
  fs.mkdirSync(folderCh, { recursive: true });
  for (const n of PAGES) fs.writeFileSync(path.join(folderCh, n), await png({ r: 220, g: 220, b: 220 }));

  // Multi-chapter fixture used to prove ids do not change when sorting changes.
  for (const name of ['Chapter 2', 'Chapter 10']) {
    const dir = path.join(fixtures, 'Stable Manga', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1.png'), await png({ r: 80, g: 90, b: 100 }));
  }

  // standalone .cbz
  const zip = new AdmZip();
  for (const n of PAGES) zip.addFile(n, await png({ r: 100, g: 150, b: 200 }));
  zip.writeZip(path.join(fixtures, 'Zip Manga.cbz'));

  // standalone .cbr (only if rar is available)
  if (hasRar) {
    const rarSrc = path.join(os.tmpdir(), `komado-rar-src-${process.pid}`);
    fs.rmSync(rarSrc, { recursive: true, force: true });
    fs.mkdirSync(rarSrc, { recursive: true });
    for (const n of PAGES) fs.writeFileSync(path.join(rarSrc, n), await png({ r: 30, g: 40, b: 50 }));
    execFileSync('rar', ['a', '-idq', '-ep', path.join(fixtures, 'Rar Manga.cbr'), ...PAGES], { cwd: rarSrc });
  }

  setConfig({ localLibraryPaths: [fixtures] });
  local.scan();
});

describe('local source', () => {
  it('scans folders and archives as manga', async () => {
    const titles = (await local.search('')).data.map((m) => m.title);
    expect(titles).toContain('Folder Manga');
    expect(titles).toContain('Zip Manga');
    if (hasRar) expect(titles).toContain('Rar Manga');
  });

  it('reads a folder chapter in natural page order', async () => {
    const manga = (await local.search('Folder')).data[0];
    const chapter = (await local.listChapters(manga.id)).data[0];
    const pages = await local.getPages(chapter.id);
    expect(pages.map((p) => path.basename(p.file))).toEqual(PAGES);
    expect((await local.loadPageBuffer(pages[0])).length).toBeGreaterThan(0);
  });

  it('reads .cbz entries', async () => {
    const manga = (await local.search('Zip')).data[0];
    const chapter = (await local.listChapters(manga.id)).data[0];
    const pages = await local.getPages(chapter.id);
    expect(pages.map((p) => p.entry)).toEqual(PAGES);
    expect((await local.loadPageBuffer(pages[0])).length).toBeGreaterThan(0);
  });

  // CVE-2026-39244 (GHSA-xcpc-8h2w-3j85): adm-zip < 0.6.0 allocated whatever
  // uncompressed size an entry's headers declared, so a ~120-byte CBZ could demand
  // ~4GB. Fixed versions size the read from the data actually present. 256 MiB is
  // enough to tell them apart: a regressed dependency allocates it and then fails
  // its CRC check in well under a second, instead of OOMing the runner.
  it('reads a CBZ entry by its real size, not a forged header size', async () => {
    const page = await png({ r: 1, g: 2, b: 3 });
    const zip = new AdmZip();
    zip.addFile('p.png', page);
    const bytes = zip.toBuffer();
    const forged = 256 * 1024 * 1024;
    bytes.writeUInt32LE(forged, bytes.indexOf(Buffer.from('PK\x03\x04', 'latin1')) + 22); // local header
    bytes.writeUInt32LE(forged, bytes.indexOf(Buffer.from('PK\x01\x02', 'latin1')) + 24); // central directory
    // Outside the scanned library so no other test sees it.
    const file = path.join(os.tmpdir(), `komado-forged-size-${process.pid}.cbz`);
    fs.writeFileSync(file, bytes);
    try {
      const data = await local.loadPageBuffer({ index: 0, kind: 'archive', file, entry: 'p.png' });
      expect(data.equals(page)).toBe(true);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it.runIf(hasRar)('reads .cbr entries via node-unrar-js', async () => {
    const manga = (await local.search('Rar')).data[0];
    const chapter = (await local.listChapters(manga.id)).data[0];
    const pages = await local.getPages(chapter.id);
    expect(pages.map((p) => p.entry)).toEqual(PAGES);
    expect((await local.loadPageBuffer(pages[0])).length).toBeGreaterThan(0);
  });

  it('keeps chapter ids stable when a new folder changes natural-sort positions', async () => {
    const manga = (await local.search('Stable Manga')).data[0];
    const before = (await local.listChapters(manga.id)).data;
    const idsByTitle = new Map(before.map((ch) => [ch.title, ch.id]));

    const inserted = path.join(fixtures, 'Stable Manga', 'Chapter 1');
    fs.mkdirSync(inserted, { recursive: true });
    fs.writeFileSync(path.join(inserted, '1.png'), await png({ r: 10, g: 20, b: 30 }));
    local.scan();
    const after = (await local.listChapters(manga.id)).data;

    expect(after.find((ch) => ch.title === 'Chapter 2').id).toBe(idsByTitle.get('Chapter 2'));
    expect(after.find((ch) => ch.title === 'Chapter 10').id).toBe(idsByTitle.get('Chapter 10'));
    expect((await local.getPages(idsByTitle.get('Chapter 2')))).toHaveLength(1);
  });
});

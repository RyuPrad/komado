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
  /* rar not installed — CBR test skipped */
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

  it.runIf(hasRar)('reads .cbr entries via node-unrar-js', async () => {
    const manga = (await local.search('Rar')).data[0];
    const chapter = (await local.listChapters(manga.id)).data[0];
    const pages = await local.getPages(chapter.id);
    expect(pages.map((p) => p.entry)).toEqual(PAGES);
    expect((await local.loadPageBuffer(pages[0])).length).toBeGreaterThan(0);
  });
});

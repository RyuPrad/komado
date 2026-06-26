import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeManga, makeChapter, globalKey } from '../../domain/shape.js';
import { envelope, paginate } from '../../lib/envelope.js';
import { naturalSort, naturalCompare } from '../../lib/natsort.js';
import { NotFoundError, UnsupportedError } from '../../lib/AppError.js';
import { getConfig } from '../../state/store.js';
import { listArchiveImages, readArchiveEntry, isArchive, isRar } from './archive.js';

export const id = 'local';
export const label = 'Local library';
export const remote = false;

const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;

// Built model: mangaId(=path) -> { mangaId, title, chapters: [{ kind, dir|file, name }] }
let model = null;

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
}
const hasImages = (dir) => listDir(dir).some((d) => d.isFile() && IMAGE_RE.test(d.name));
const cleanName = (name) => name.replace(/\.(cbz|zip|cbr|rar)$/i, '');
const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

// A directory is a manga. Its chapters are: image subfolders, then archive
// files; or — if neither — the loose images in the folder become one chapter.
function buildMangaFromDir(dirPath) {
  const entries = listDir(dirPath);
  const chapters = [];

  const chapterDirs = entries.filter((e) => e.isDirectory() && hasImages(path.join(dirPath, e.name)));
  for (const d of naturalSort(chapterDirs, (e) => e.name)) {
    chapters.push({ kind: 'dir', dir: path.join(dirPath, d.name), name: d.name });
  }
  const archives = entries.filter((e) => e.isFile() && isArchive(e.name));
  for (const f of naturalSort(archives, (e) => e.name)) {
    chapters.push({ kind: 'archive', file: path.join(dirPath, f.name), name: f.name });
  }
  if (chapters.length === 0 && hasImages(dirPath)) {
    chapters.push({ kind: 'dir', dir: dirPath, name: path.basename(dirPath) });
  }
  return chapters.length ? { mangaId: dirPath, title: path.basename(dirPath), chapters } : null;
}

// A standalone .cbz/.zip is a single-chapter manga.
function buildMangaFromArchive(filePath) {
  return {
    mangaId: filePath,
    title: cleanName(path.basename(filePath)),
    chapters: [{ kind: 'archive', file: filePath, name: path.basename(filePath) }],
  };
}

export function scan() {
  model = new Map();
  for (const libPath of getConfig().localLibraryPaths || []) {
    const abs = path.resolve(expandHome(libPath));
    for (const entry of naturalSort(listDir(abs), (e) => e.name)) {
      const full = path.join(abs, entry.name);
      const built = entry.isDirectory()
        ? buildMangaFromDir(full)
        : isArchive(entry.name) ? buildMangaFromArchive(full) : null;
      if (built) model.set(built.mangaId, built);
    }
  }
  return model;
}

function ensureModel() {
  if (!model) scan();
  return model;
}

function toManga(built) {
  return makeManga({
    source: id,
    id: built.mangaId,
    title: built.title,
    status: 'local',
    chaptersCount: built.chapters.length,
    language: getConfig().language,
    raw: { path: built.mangaId },
  });
}

export async function search(query, { offset = 0, limit = 1000 } = {}) {
  ensureModel();
  const q = (query || '').toLowerCase();
  let list = [...model.values()];
  if (q) list = list.filter((b) => b.title.toLowerCase().includes(q));
  list.sort((a, b) => naturalCompare(a.title, b.title));
  const data = list.slice(offset, offset + limit).map(toManga);
  return envelope(data, {
    pagination: paginate({ offset, limit, total: list.length }),
    meta: { source: id, query },
  });
}

export async function getManga(mangaId) {
  ensureModel();
  const built = model.get(mangaId);
  if (!built) throw new NotFoundError(`Local manga not found: ${mangaId}`);
  return toManga(built);
}

export async function listChapters(mangaId, { offset = 0, limit = 100_000 } = {}) {
  ensureModel();
  const built = model.get(mangaId);
  if (!built) throw new NotFoundError(`Local manga not found: ${mangaId}`);
  const mangaKey = globalKey(id, mangaId);
  const data = built.chapters.map((ch, i) =>
    makeChapter({
      source: id,
      id: `${mangaId}#${i}`,
      mangaKey,
      number: built.chapters.length > 1 ? String(i + 1) : null,
      title: cleanName(ch.name),
      raw: ch,
    }),
  );
  return envelope(data.slice(offset, offset + limit), {
    pagination: paginate({ offset, limit, total: data.length }),
    meta: { source: id, mangaId },
  });
}

export async function getPages(chapterId) {
  ensureModel();
  const hash = chapterId.lastIndexOf('#');
  const mangaId = chapterId.slice(0, hash);
  const chIndex = Number(chapterId.slice(hash + 1));
  const built = model.get(mangaId);
  if (!built) throw new NotFoundError(`Local manga not found: ${mangaId}`);
  const ch = built.chapters[chIndex];
  if (!ch) throw new NotFoundError(`Chapter not found: ${chapterId}`);

  if (ch.kind === 'dir') {
    const files = naturalSort(
      listDir(ch.dir).filter((e) => e.isFile() && IMAGE_RE.test(e.name)).map((e) => e.name),
    );
    return files.map((name, index) => ({ index, kind: 'file', file: path.join(ch.dir, name) }));
  }
  if (isRar(ch.file)) {
    throw new UnsupportedError('CBR/RAR not supported yet — convert to .cbz or install node-unrar-js.');
  }
  return listArchiveImages(ch.file).map((entry, index) => ({
    index, kind: 'archive', file: ch.file, entry,
  }));
}

export async function loadPageBuffer(page) {
  if (page.kind === 'file') return fsp.readFile(page.file);
  if (page.kind === 'archive') return readArchiveEntry(page.file, page.entry);
  throw new NotFoundError('Unknown local page descriptor');
}

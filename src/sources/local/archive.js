import AdmZip from 'adm-zip';
import { readFile } from 'node:fs/promises';
import { naturalSort } from '../../lib/natsort.js';

const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;

export const isArchive = (name) => /\.(cbz|zip|cbr|rar)$/i.test(name);
export const isRar = (name) => /\.(cbr|rar)$/i.test(name);

// ---- ZIP / CBZ (adm-zip parses the whole file on construct → tiny LRU) ----
const zipCache = new Map();
function openZip(filePath) {
  let zip = zipCache.get(filePath);
  if (!zip) {
    zip = new AdmZip(filePath);
    zipCache.set(filePath, zip);
    if (zipCache.size > 8) zipCache.delete(zipCache.keys().next().value);
  }
  return zip;
}
function listZipImages(filePath) {
  return naturalSort(
    openZip(filePath)
      .getEntries()
      .filter((e) => !e.isDirectory && IMAGE_RE.test(e.entryName))
      .map((e) => e.entryName),
  );
}
function readZipEntry(filePath, entryName) {
  const entry = openZip(filePath).getEntry(entryName);
  if (!entry) throw new Error(`Entry not found in archive: ${entryName}`);
  return entry.getData();
}

// ---- RAR / CBR (node-unrar-js - WASM, loaded lazily on first use) ----
let unrarPromise = null;
const getUnrar = () => (unrarPromise ??= import('node-unrar-js'));

const rarCache = new Map();
async function openRar(filePath) {
  let extractor = rarCache.get(filePath);
  if (!extractor) {
    const { createExtractorFromData } = await getUnrar();
    const buf = await readFile(filePath);
    extractor = await createExtractorFromData({
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    });
    rarCache.set(filePath, extractor);
    if (rarCache.size > 4) rarCache.delete(rarCache.keys().next().value);
  }
  return extractor;
}
async function listRarImages(filePath) {
  const extractor = await openRar(filePath);
  const names = [];
  for (const header of extractor.getFileList().fileHeaders) {
    if (!header.flags.directory && IMAGE_RE.test(header.name)) names.push(header.name);
  }
  return naturalSort(names);
}
async function readRarEntry(filePath, entryName) {
  const extractor = await openRar(filePath);
  const [file] = [...extractor.extract({ files: [entryName] }).files];
  if (!file?.extraction) throw new Error(`Failed to extract from RAR: ${entryName}`);
  return Buffer.from(file.extraction);
}

// ---- Unified async API (callers don't care about the container format) ----
export async function listArchiveImages(filePath) {
  return isRar(filePath) ? listRarImages(filePath) : listZipImages(filePath);
}
export async function readArchiveEntry(filePath, entryName) {
  return isRar(filePath) ? readRarEntry(filePath, entryName) : readZipEntry(filePath, entryName);
}

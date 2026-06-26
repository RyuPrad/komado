import AdmZip from 'adm-zip';
import { naturalSort } from '../../lib/natsort.js';

const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;

export const isArchive = (name) => /\.(cbz|zip|cbr|rar)$/i.test(name);
export const isRar = (name) => /\.(cbr|rar)$/i.test(name);

// AdmZip parses the whole archive on construction, so keep a tiny LRU of open
// archives — a chapter reads many pages from the same file.
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

export function listArchiveImages(filePath) {
  const names = openZip(filePath)
    .getEntries()
    .filter((e) => !e.isDirectory && IMAGE_RE.test(e.entryName))
    .map((e) => e.entryName);
  return naturalSort(names);
}

export function readArchiveEntry(filePath, entryName) {
  const entry = openZip(filePath).getEntry(entryName);
  if (!entry) throw new Error(`Entry not found in archive: ${entryName}`);
  return entry.getData();
}

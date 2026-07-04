import * as mangadex from './mangadex/index.js';
import * as local from './local/index.js';

// Source registry. Every source implements the same interface:
//   search, getManga, listChapters, getPages, loadPageBuffer
// so the hooks/UI never branch on where a manga comes from.
const sources = { mangadex, local };

export function getSource(sourceId) {
  const source = sources[sourceId];
  if (!source) throw new Error(`Unknown source: ${sourceId}`);
  return source;
}

export const SOURCES = sources;
export const REMOTE_SOURCES = Object.values(sources).filter((s) => s.remote);
export const LOCAL_SOURCES = Object.values(sources).filter((s) => !s.remote);

// Fetch EVERY chapter of a manga by walking the source's pagination. A single
// listChapters page tops out at 500 rows (the MangaDex feed cap), so long
// series need several pages - a lone capped call silently loses everything
// past ~500 chapters, and Continue can't find its saved chapter in the list.
// Duplicate scanlations of one chapter that straddle a page boundary are
// collapsed with the same volume:number rule the MangaDex source applies
// within a page (a no-op for sources whose numbers are already unique).
export async function listAllChapters(source, mangaId, { language, signal, pageSize = 500, maxPages = 30 } = {}) {
  const all = [];
  const seen = new Set();
  let offset = 0;
  for (let i = 0; i < maxPages; i += 1) {
    const res = await source.listChapters(mangaId, { offset, limit: pageSize, language, signal });
    for (const ch of res.data) {
      const dedup = `${ch.volume}:${ch.number}`;
      if (ch.number != null && seen.has(dedup)) continue;
      seen.add(dedup);
      all.push(ch);
    }
    const pg = res.pagination;
    if (!pg?.hasMore) break;
    offset = pg.offset + pg.limit;
  }
  return all;
}

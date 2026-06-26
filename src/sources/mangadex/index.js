import { mdGet } from './client.js';
import { normalizeManga, normalizeChapter } from './normalize.js';
import { fetchWithBackoff } from '../../lib/fetchWithBackoff.js';
import { createCache } from '../../lib/cache.js';
import { envelope, paginate } from '../../lib/envelope.js';
import { NotFoundError } from '../../lib/AppError.js';
import { MANGADEX } from '../../config.js';
import { globalKey } from '../../domain/shape.js';
import { getConfig } from '../../state/store.js';

export const id = 'mangadex';
export const label = 'MangaDex';
export const remote = true;

const cache = createCache({ ttlMs: 5 * 60_000, negativeTtlMs: 15_000 });

export async function search(query, { offset = 0, limit = MANGADEX.pageLimit, signal } = {}) {
  const cfg = getConfig();
  const order = query ? { relevance: 'desc' } : { followedCount: 'desc' };
  const key = `search:${query}:${offset}:${limit}:${cfg.contentRating.join(',')}`;
  const res = await cache.wrap(key, () =>
    mdGet('/manga', {
      title: query || undefined,
      limit,
      offset,
      includes: ['cover_art', 'author', 'artist'],
      contentRating: cfg.contentRating,
      hasAvailableChapters: 'true',
      order,
    }, { signal }),
  );
  const data = (res.data || []).map(normalizeManga);
  return envelope(data, {
    pagination: paginate({ offset: res.offset, limit: res.limit, total: res.total }),
    meta: { source: id, query },
  });
}

export async function getManga(mangaId, { signal } = {}) {
  const res = await cache.wrap(`manga:${mangaId}`, () =>
    mdGet(`/manga/${mangaId}`, { includes: ['cover_art', 'author', 'artist'] }, { signal }),
  );
  if (!res.data) throw new NotFoundError(`Manga ${mangaId} not found`);
  return normalizeManga(res.data);
}

export async function listChapters(mangaId, { offset = 0, limit = 96, language, signal } = {}) {
  const cfg = getConfig();
  const lang = language || cfg.language;
  const key = `chapters:${mangaId}:${lang}:${offset}:${limit}`;
  const res = await cache.wrap(key, () =>
    mdGet(`/manga/${mangaId}/feed`, {
      limit,
      offset,
      translatedLanguage: lang ? [lang] : undefined,
      contentRating: cfg.contentRating,
      includes: ['scanlation_group'],
      order: { volume: 'asc', chapter: 'asc' },
    }, { signal }),
  );

  const mangaKey = globalKey(id, mangaId);
  // MangaDex returns one row per scanlation; collapse duplicates by chapter no.
  const seen = new Set();
  const data = [];
  for (const entry of res.data || []) {
    // Externally-hosted chapters (MangaPlus etc.) have no pages we can render.
    if (entry.attributes?.externalUrl) continue;
    const ch = normalizeChapter(entry, mangaKey);
    const dedup = `${ch.volume}:${ch.number}`;
    if (ch.number != null && seen.has(dedup)) continue;
    seen.add(dedup);
    data.push(ch);
  }
  return envelope(data, {
    pagination: paginate({ offset: res.offset, limit: res.limit, total: res.total }),
    meta: { source: id, mangaId, language: lang },
  });
}

// Page descriptors with a directly fetchable URL. The at-home token in baseUrl
// expires fast, so this is only briefly cached.
export async function getPages(chapterId, { signal } = {}) {
  const cfg = getConfig();
  const server = await cache.wrap(
    `pages:${chapterId}:${cfg.dataSaver ? 'ds' : 'hq'}`,
    () => mdGet(`/at-home/server/${chapterId}`, null, { signal }),
    60_000,
  );
  if (!server.chapter) throw new NotFoundError(`No pages for chapter ${chapterId}`);

  // Prefer the configured quality, but fall back to the other if it's empty.
  let mode = cfg.dataSaver ? 'data-saver' : 'data';
  let files = cfg.dataSaver ? server.chapter.dataSaver : server.chapter.data;
  if (!files || files.length === 0) {
    mode = cfg.dataSaver ? 'data' : 'data-saver';
    files = cfg.dataSaver ? server.chapter.data : server.chapter.dataSaver;
  }
  if (!files || files.length === 0) {
    throw new NotFoundError(`Chapter ${chapterId} has no hosted pages`);
  }
  return files.map((file, index) => ({
    index,
    url: `${server.baseUrl}/${mode}/${server.chapter.hash}/${file}`,
  }));
}

export async function loadPageBuffer(page, { signal } = {}) {
  const res = await fetchWithBackoff(page.url, {
    headers: { 'User-Agent': MANGADEX.userAgent },
    timeoutMs: 30_000,
    signal,
  });
  if (!res.ok) throw new NotFoundError(`Failed to load page ${page.index} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

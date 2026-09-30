import { mdGet, mdSend } from './client.js';
import { isLoggedIn, getSessionGeneration } from './auth.js';
import { normalizeManga, normalizeChapter } from './normalize.js';
import { fetchWithBackoff } from '../../lib/fetchWithBackoff.js';
import { createCache } from '../../lib/cache.js';
import { envelope, paginate } from '../../lib/envelope.js';
import { NotFoundError } from '../../lib/AppError.js';
import { MANGADEX } from '../../config.js';
import { globalKey } from '../../domain/shape.js';
import { getConfig } from '../../state/store.js';
import { logger } from '../../lib/logger.js';

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
    }),
    undefined, { signal },
  );
  const data = (res.data || []).map(normalizeManga);
  return envelope(data, {
    pagination: paginate({ offset: res.offset, limit: res.limit, total: res.total }),
    meta: { source: id, query },
  });
}

export async function getManga(mangaId, { signal } = {}) {
  const res = await cache.wrap(`manga:${mangaId}`, () =>
    mdGet(`/manga/${mangaId}`, { includes: ['cover_art', 'author', 'artist'] }),
    undefined, { signal },
  );
  if (!res.data) throw new NotFoundError(`Manga ${mangaId} not found`);
  return normalizeManga(res.data);
}

export async function listChapters(mangaId, { offset = 0, limit = 96, language, signal } = {}) {
  const cfg = getConfig();
  const lang = language || cfg.language;
  // Ratings are a set semantically. Normalize them so a changed set invalidates
  // the feed cache while a harmless ordering change keeps sharing the same entry.
  const ratings = [...new Set(cfg.contentRating || [])].sort();
  const key = `chapters:${mangaId}:${lang}:${offset}:${limit}:${ratings.join(',')}`;
  const res = await cache.wrap(key, () =>
    mdGet(`/manga/${mangaId}/feed`, {
      limit,
      offset,
      translatedLanguage: lang ? [lang] : undefined,
      contentRating: ratings,
      includes: ['scanlation_group'],
      order: { volume: 'asc', chapter: 'asc' },
    }),
    undefined, { signal },
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
// expires fast, so this is only briefly cached. `fresh` drops the cached server
// handout first - used to rebuild URLs after the token dies mid-chapter.
export async function getPages(chapterId, { signal, fresh = false } = {}) {
  const cfg = getConfig();
  const key = `pages:${chapterId}:${cfg.dataSaver ? 'ds' : 'hq'}`;
  if (fresh) cache.delete(key);
  const server = await cache.wrap(
    key,
    () => mdGet(`/at-home/server/${chapterId}`, null),
    60_000,
    { signal },
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
    chapterId,
    url: `${server.baseUrl}/${mode}/${server.chapter.hash}/${file}`,
  }));
}

export async function loadPageBuffer(page, { signal } = {}) {
  const fetchPage = (url) => fetchWithBackoff(url, {
    headers: { 'User-Agent': MANGADEX.userAgent },
    timeoutMs: 30_000,
    signal,
  });
  let res = await fetchPage(page.url);
  // The at-home baseUrl embeds a short-lived token: a chapter kept open longer
  // than its lifetime (a slow read) starts 4xx-ing on later pages. Rebuild the
  // URL from a fresh server handout and retry once before giving up.
  if (!res.ok && page.chapterId) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    const rebuilt = await getPages(page.chapterId, { signal, fresh: true }).catch(() => null);
    const retry = rebuilt?.[page.index];
    if (retry) res = await fetchPage(retry.url);
  }
  if (!res.ok) throw new NotFoundError(`Failed to load page ${page.index} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// ---- Authenticated features (require login) ----------------------------

// The signed-in user's followed manga, normalized like search results.
export async function getFollows({ offset = 0, limit = MANGADEX.pageLimit, signal } = {}) {
  // /user/follows/manga rejects contentRating[] (HTTP 400) - it returns ALL of
  // the user's follows regardless of rating, which is what we want here anyway.
  const res = await mdGet('/user/follows/manga', {
    limit,
    offset,
    includes: ['cover_art', 'author', 'artist'],
  }, { signal, auth: true });
  const data = (res.data || []).map(normalizeManga);
  return envelope(data, {
    pagination: paginate({ offset: res.offset, limit: res.limit, total: res.total }),
    meta: { source: id },
  });
}

// Chapter IDs the user has marked read for this manga (for decorating the list).
export async function getReadMarkers(mangaId, { signal } = {}) {
  const res = await mdGet(`/manga/${mangaId}/read`, null, { signal, auth: true });
  return res.data || [];
}

export async function markChaptersRead(mangaId, chapterIdsRead, { signal, session } = {}) {
  if (!chapterIdsRead?.length) return;
  await mdSend('POST', `/manga/${mangaId}/read`, {
    chapterIdsRead,
    chapterIdsUnread: [],
  }, { signal, session });
}

// Fire-and-forget read-marker push when a chapter is finished. Self-guards on
// login + the syncProgress setting and dedupes per session, so a reader can
// call it freely (e.g. on every settle at the last page) without spamming.
let pushedRead = { generation: null, chapters: new Set() };
export async function syncChapterRead(mangaId, chapterId) {
  if (!chapterId) return;
  if (!isLoggedIn() || !getConfig().syncProgress) return;
  const generation = getSessionGeneration();
  if (pushedRead.generation !== generation) pushedRead = { generation, chapters: new Set() };
  const pushed = pushedRead.chapters;
  if (pushed.has(chapterId)) return;
  pushed.add(chapterId);
  try {
    await markChaptersRead(mangaId, [chapterId], { session: generation });
  } catch (err) {
    pushed.delete(chapterId); // a stale failure must not clear the new session's set
    logger.warn('failed to push read marker', err);
  }
}

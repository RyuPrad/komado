// The unified data-shape contract. Rows from MangaDex and from the local
// filesystem are normalized into ONE Manga/Chapter shape, so every downstream
// consumer (search, reader, progress, UI) treats them identically. The only
// source-specific seam is `source.loadPageBuffer()`, which resolves raw bytes.

export const globalKey = (source, id) => `${source}:${id}`;

export function makeManga(p) {
  return {
    source: p.source,
    id: String(p.id),
    key: globalKey(p.source, p.id),
    title: p.title || 'Untitled',
    altTitles: p.altTitles || [],
    description: p.description || '',
    authors: p.authors || [],
    status: p.status || 'unknown',
    tags: p.tags || [],
    coverUrl: p.coverUrl || null,
    language: p.language || 'en',
    chaptersCount: p.chaptersCount ?? null,
    raw: p.raw,
  };
}

export function makeChapter(p) {
  return {
    source: p.source,
    id: String(p.id),
    key: globalKey(p.source, p.id),
    mangaKey: p.mangaKey,
    number: p.number ?? null,   // string like "12.5", or null for oneshots
    volume: p.volume ?? null,
    title: p.title || '',
    language: p.language || 'en',
    pages: p.pages ?? null,
    publishedAt: p.publishedAt || null,
    raw: p.raw,
  };
}

export function chapterLabel(ch) {
  const head = ch.number != null && ch.number !== ''
    ? `Ch. ${ch.number}${ch.volume != null && ch.volume !== '' ? ` (Vol. ${ch.volume})` : ''}`
    : 'Oneshot';
  return ch.title ? `${head} - ${ch.title}` : head;
}

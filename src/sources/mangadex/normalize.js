import { makeManga, makeChapter, globalKey } from '../../domain/shape.js';
import { MANGADEX } from '../../config.js';

const SOURCE = 'mangadex';

// MangaDex localizes strings as { en: "...", ja: "..." }. Prefer English, then
// whatever's first.
function localized(map) {
  if (!map || typeof map !== 'object') return '';
  return map.en || map[Object.keys(map)[0]] || '';
}

export function normalizeManga(entry) {
  const attr = entry.attributes || {};
  const rels = entry.relationships || [];

  const cover = rels.find((r) => r.type === 'cover_art');
  const coverFile = cover?.attributes?.fileName;
  const coverUrl = coverFile
    ? `${MANGADEX.uploads}/covers/${entry.id}/${coverFile}.512.jpg`
    : null;

  const authors = [
    ...new Set(
      rels
        .filter((r) => r.type === 'author' || r.type === 'artist')
        .map((r) => r.attributes?.name)
        .filter(Boolean),
    ),
  ];

  const altTitles = (attr.altTitles || [])
    .map((o) => Object.values(o)[0])
    .filter(Boolean);

  const tags = (attr.tags || [])
    .map((t) => t.attributes?.name?.en)
    .filter(Boolean);

  return makeManga({
    source: SOURCE,
    id: entry.id,
    title: localized(attr.title) || altTitles[0] || 'Untitled',
    altTitles,
    description: localized(attr.description),
    authors,
    status: attr.status || 'unknown',
    tags,
    coverUrl,
    language: attr.originalLanguage || 'en',
    raw: entry,
  });
}

export function normalizeChapter(entry, mangaKey) {
  const attr = entry.attributes || {};
  const mangaRel = (entry.relationships || []).find((r) => r.type === 'manga');
  return makeChapter({
    source: SOURCE,
    id: entry.id,
    mangaKey: mangaKey || (mangaRel ? globalKey(SOURCE, mangaRel.id) : null),
    number: attr.chapter ?? null,
    volume: attr.volume ?? null,
    title: attr.title || '',
    language: attr.translatedLanguage || 'en',
    pages: attr.pages ?? null,
    publishedAt: attr.publishAt ? new Date(attr.publishAt) : null,
    raw: entry,
  });
}

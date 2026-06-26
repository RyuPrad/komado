import { describe, it, expect } from 'vitest';
import { normalizeManga, normalizeChapter } from '../src/sources/mangadex/normalize.js';

const sampleManga = {
  id: 'abc',
  attributes: {
    title: { en: 'Test Manga' },
    description: { en: 'A description.' },
    status: 'ongoing',
    originalLanguage: 'ja',
    altTitles: [{ ja: 'てすと' }],
    tags: [{ attributes: { name: { en: 'Action' } } }, { attributes: { name: { en: 'Drama' } } }],
  },
  relationships: [
    { type: 'cover_art', attributes: { fileName: 'cover.jpg' } },
    { type: 'author', attributes: { name: 'Jane Doe' } },
    { type: 'artist', attributes: { name: 'Jane Doe' } }, // duplicate name → deduped
  ],
};

describe('mangadex normalize', () => {
  it('maps a manga into the unified shape', () => {
    const m = normalizeManga(sampleManga);
    expect(m.source).toBe('mangadex');
    expect(m.key).toBe('mangadex:abc');
    expect(m.title).toBe('Test Manga');
    expect(m.authors).toEqual(['Jane Doe']);
    expect(m.tags).toEqual(['Action', 'Drama']);
    expect(m.coverUrl).toMatch(/\/covers\/abc\/cover\.jpg\.512\.jpg$/);
  });

  it('falls back to an alt title when no English title exists', () => {
    const m = normalizeManga({ id: 'z', attributes: { title: {}, altTitles: [{ ja: 'タイトル' }] }, relationships: [] });
    expect(m.title).toBe('タイトル');
  });

  it('maps a chapter and derives mangaKey from the relationship', () => {
    const c = normalizeChapter({
      id: 'ch1',
      attributes: { chapter: '1', volume: '1', title: 'Start', translatedLanguage: 'en', pages: 10, publishAt: '2024-01-01T00:00:00Z' },
      relationships: [{ type: 'manga', id: 'abc' }],
    });
    expect(c.key).toBe('mangadex:ch1');
    expect(c.mangaKey).toBe('mangadex:abc');
    expect(c.number).toBe('1');
    expect(c.publishedAt).toBeInstanceOf(Date);
  });
});

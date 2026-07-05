import { describe, it, expect } from 'vitest';
import { renderStatusBar, hintLine } from '../src/render/statusbar.js';
import { displayWidth, truncateWidth } from '../src/lib/text.js';

// eslint-disable-next-line no-control-regex
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const HINTS = [
  { keys: 'a/d', label: 'page' },
  { keys: 'j/k', label: 'pan' },
  { keys: 'n/p', label: 'chapter' },
  { keys: 'f', label: 'fit', active: false },
  { keys: 'q', label: 'back' },
];
const bar = (over = {}) => renderStatusBar({
  cols: 120,
  title: 'Berserk',
  info: 'Ch. 0.01 (Vol. 1) - The Black Swordsman',
  page: '11/94',
  hints: HINTS,
  ...over,
});

describe('displayWidth / truncateWidth', () => {
  it('counts CJK as 2 cells, combining marks as 0', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('ベルセルク')).toBe(10);
    expect(displayWidth('é')).toBe(1);
  });

  it('truncates by cells without splitting a wide glyph', () => {
    expect(truncateWidth('abcdef', 6)).toBe('abcdef');
    expect(truncateWidth('abcdef', 4)).toBe('abc…');
    expect(truncateWidth('ベルセルク', 5)).toBe('ベル…');
    expect(truncateWidth('ベルセルク', 4)).toBe('ベ…'); // ル won't fit in 3 cells
  });
});

describe('renderStatusBar', () => {
  it('always renders exactly cols display cells', () => {
    for (const cols of [20, 34, 60, 120, 200]) {
      for (const title of ['Berserk', 'ベルセルク・非常に長いタイトルのマンガ']) {
        const out = bar({ cols, title });
        expect(displayWidth(plain(out))).toBe(cols);
      }
    }
  });

  it('shows title, chapter info, hints and page when wide', () => {
    const p = plain(bar());
    expect(p).toContain(' Berserk ');
    expect(p).toContain('The Black Swordsman');
    expect(p).toContain('a/d page');
    expect(p).toContain('q back');
    expect(p).toContain(' 11/94 ');
  });

  it('truncates the chapter info before touching hints', () => {
    const p = plain(bar({ cols: 75 }));
    expect(p).toContain('…');
    expect(p).toContain('a/d');
    expect(p).toContain(' 11/94 ');
  });

  it('drops hints (never the page chip) when narrow', () => {
    const p = plain(bar({ cols: 30 }));
    expect(p).not.toContain('a/d');
    expect(p).toContain(' 11/94 ');
    expect(p).toContain('Berserk');
  });

  it('truncates the title as a last resort', () => {
    const p = plain(bar({ cols: 20, title: 'A very long manga title' }));
    expect(displayWidth(p)).toBe(20);
    expect(p).toContain('…');
    expect(p).toContain(' 11/94 ');
  });

  it('lights the fit hint up as a chip only when active', () => {
    expect(bar()).not.toContain('48;5;109');
    const lit = bar({ hints: HINTS.map((h) => (h.keys === 'f' ? { ...h, active: true } : h)) });
    expect(lit).toContain('48;5;109');
    expect(plain(lit)).toContain(' f fit ');
  });

  it('emits pure ASCII chrome for ASCII input (bitmap-font terminals)', () => {
    const out = bar({ title: 'Berserk', info: 'Ch. 1 - Intro' });
    // eslint-disable-next-line no-control-regex
    expect(/^[\x20-\x7e\x1b]*$/.test(out)).toBe(true);
  });

  it('survives the loading state (page total unknown)', () => {
    const p = plain(bar({ page: '1/?' }));
    expect(p).toContain(' 1/? ');
    expect(displayWidth(p)).toBe(120);
  });
});

describe('hintLine', () => {
  it('renders bold keys and dim labels with a trailing reset', () => {
    const out = hintLine([{ keys: 'n/p', label: 'chapter' }, { keys: 'q', label: 'back' }]);
    expect(plain(out)).toBe('n/p chapter  q back');
    expect(out).toContain('\x1b[0;1mn/p');
    expect(out).toContain('\x1b[0;2m chapter');
    expect(out.endsWith('\x1b[0m')).toBe(true);
  });
});

import { getSource } from './sources/index.js';
import { setProgress } from './state/store.js';
import { chapterLabel } from './domain/shape.js';
import { encodePixels, prepareImage } from './render/sixel.js';
import { logger } from './lib/logger.js';

const ESC = '\x1b';

// A self-contained, raw-mode page reader that renders pages as sixel/kitty
// pixels. It fully owns the terminal (Ink is unmounted before this runs), so
// there's no cell layout to fight. Returns the route Ink should resume at.
export async function runViewer({ sourceId, manga, chapters, chapterIndex, startPage = 0, caps = {} }) {
  const source = getSource(sourceId);
  const { stdin, stdout } = process;
  const format = caps.kitty ? 'kitty' : 'sixel';

  let ci = chapterIndex;
  let pi = startPage;
  let scroll = 0;
  let fitWidth = true; // full-width + vertical pan (max resolution); `f` toggles
  let pages = null;
  let maxScroll = 0;
  let busy = false;

  const size = () => ({
    cols: Math.max(20, stdout.columns || 80),
    rows: Math.max(6, stdout.rows || 24),
  });

  async function ensurePages() {
    if (pages) return;
    pages = await source.getPages(chapters[ci].id);
    pi = Math.max(0, Math.min(pi, pages.length - 1));
  }

  function statusBar() {
    const { cols } = size();
    const left = `${manga.title} · ${chapterLabel(chapters[ci])} · ${pi + 1}/${pages ? pages.length : '?'}${fitWidth ? '' : ' · fit'}`;
    const right = 'n/p page · ↑↓ pan · N/P ch · f fit · q back';
    const gap = Math.max(1, cols - left.length - right.length - 2);
    return ` ${left}${' '.repeat(gap)}${right} `.slice(0, cols);
  }

  async function draw() {
    busy = true;
    const { cols, rows } = size();
    const imgRows = rows - 1; // reserve the bottom row for the status bar
    try {
      await ensurePages();
      if (!pages.length) throw new Error('This chapter has no hosted pages.');
      const buf = await source.loadPageBuffer(pages[pi]);

      const prepared = await prepareImage(buf, {
        mode: fitWidth ? 'width' : 'fit',
        cols,
        rows: imgRows,
        scroll,
        cellW: caps.cellW,
        cellH: caps.cellH,
      });
      maxScroll = prepared.maxScroll;
      scroll = prepared.scroll;
      const sixel = await encodePixels(prepared.buffer, { format });

      stdout.write(`${ESC}[2J${ESC}[H`); // clear + cursor home
      stdout.write(sixel);
      stdout.write(`${ESC}[${rows};1H${ESC}[7m${statusBar()}${ESC}[0m`);

      setProgress(manga.key, {
        source: sourceId,
        mangaId: manga.id,
        mangaTitle: manga.title,
        chapterId: chapters[ci].id,
        chapterNumber: chapters[ci].number,
        page: pi,
      });
      // Last page reached → push a read-marker to MangaDex (self-guarded/deduped).
      if (pi === pages.length - 1 && source.syncChapterRead) {
        source.syncChapterRead(manga.id, chapters[ci].id);
      }
    } catch (err) {
      logger.warn('viewer draw failed', err);
      stdout.write(`${ESC}[2J${ESC}[H${ESC}[0m`);
      stdout.write(`Error: ${err.message}\r\n\r\nN/P chapter · q back\r\n`);
    } finally {
      busy = false;
    }
  }

  function changeChapter(delta) {
    const next = ci + delta;
    if (next < 0 || next >= chapters.length) return false;
    ci = next;
    pi = 0;
    scroll = 0;
    pages = null;
    return true;
  }
  function nextPage() {
    if (pages && pi < pages.length - 1) { pi += 1; scroll = 0; }
    else changeChapter(1);
  }
  function prevPage() {
    if (pi > 0) { pi -= 1; scroll = 0; }
    else changeChapter(-1);
  }

  const prevRaw = stdin.isRaw;
  let onKey;
  // Ink leaves stdin unref'd after unmount, so a bare `await`-for-keypress won't
  // keep the process alive — it would exit the moment the first page is drawn.
  // A ref'd timer holds the event loop open until we're done.
  const keepAlive = setInterval(() => {}, 1 << 30);
  // Re-render on terminal resize so the page tracks the window size.
  const onResize = () => { if (!busy) draw(); };
  try {
    await draw();
    stdout.on('resize', onResize);

    await new Promise((resolve) => {
      onKey = async (data) => {
        if (busy) return;
        const k = data.toString('latin1');
        const { rows } = size();
        const pageStep = Math.max(1, rows - 2);

        if (k === 'q' || k === ESC) { resolve(); return; }
        if (k === 'n' || k === ' ' || k === `${ESC}[C`) {
          if (fitWidth && scroll < maxScroll) scroll = Math.min(maxScroll, scroll + pageStep);
          else nextPage();
        } else if (k === 'p' || k === `${ESC}[D`) {
          if (fitWidth && scroll > 0) scroll = Math.max(0, scroll - pageStep);
          else prevPage();
        } else if (k === 'j' || k === `${ESC}[B`) {
          scroll = Math.min(maxScroll, scroll + 2);
        } else if (k === 'k' || k === `${ESC}[A`) {
          scroll = Math.max(0, scroll - 2);
        } else if (k === 'N') {
          changeChapter(1);
        } else if (k === 'P') {
          changeChapter(-1);
        } else if (k === 'f') {
          fitWidth = !fitWidth;
          scroll = 0;
        } else if (k === 'g') {
          scroll = 0;
        } else if (k === 'G') {
          scroll = maxScroll;
        } else {
          return; // ignore other keys without redrawing
        }
        await draw();
      };

      // Enter raw mode *after* the first draw — Ink's unmount restores cooked
      // mode on a deferred tick, which would otherwise leave stdin line-buffered
      // (so single keypresses never arrive).
      stdin.removeAllListeners('data');
      try { stdin.setRawMode(true); } catch { /* ignore */ }
      stdin.resume();
      stdin.ref?.();
      stdin.on('data', onKey);
    });
  } finally {
    clearInterval(keepAlive);
    stdout.removeListener('resize', onResize);
    if (onKey) stdin.removeListener('data', onKey);
    try { stdin.setRawMode(prevRaw); } catch { /* ignore */ }
    stdout.write(`${ESC}[2J${ESC}[H${ESC}[0m`);
  }

  return { name: 'manga', params: { sourceId, manga } };
}

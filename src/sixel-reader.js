import { getSource } from './sources/index.js';
import { setProgress } from './state/store.js';
import { chapterLabel } from './domain/shape.js';
import { encodePixels, prepareImage, scalePage, encodeSixelPage, sliceSixelPage } from './render/sixel.js';
import { logger } from './lib/logger.js';

const ESC = '\x1b';

// Synchronized-update markers (DEC private mode 2026). Wrapping a frame makes a
// supporting terminal present it atomically — so the strip-scroll's "scroll the
// region, then repaint the freed strip" can't flash a blank strip at the leading
// edge. Ignored (harmless) on terminals that don't implement it.
const SYNC_BEGIN = Buffer.from(`${ESC}[?2026h`, 'latin1');
const SYNC_END = Buffer.from(`${ESC}[?2026l`, 'latin1');

// A self-contained, raw-mode page reader that renders pages as sixel/kitty
// pixels. It fully owns the terminal (Ink is unmounted before this runs), so
// there's no cell layout to fight. Returns the route Ink should resume at.
export async function runViewer({ sourceId, manga, chapters, chapterIndex, startPage = 0, caps = {} }) {
  const source = getSource(sourceId);
  const { stdin, stdout } = process;
  const format = caps.kitty ? 'kitty' : 'sixel';

  let ci = chapterIndex;
  let pi = startPage;
  let scroll = 0;      // current vertical pan (cells)
  let fitWidth = true; // full-width + vertical pan (max resolution); `f` toggles
  let pages = null;
  let maxScroll = 0;

  // Cell/band geometry for the optional strip-scroll. Sixel bands are 6px tall;
  // the terminal scrolls by whole cells. A "slot" = LCM(6, cellH)px is the
  // smallest shift that's whole in BOTH grids — scrolling by slots lets us move
  // the on-screen pixels with the terminal and repaint only the newly-exposed
  // strip (seam-free), instead of re-sending the entire viewport every step.
  // Opt-in (KOMADO_SCROLL_DELTA=1) because it relies on the terminal scrolling
  // sixel graphics with the text (true on xterm; not universal).
  const cellH = caps.cellH || 20;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const slotBands = cellH / gcd(6, cellH);
  const slotCells = 6 / gcd(6, cellH);
  const deltaScroll = format === 'sixel' && process.env.KOMADO_SCROLL_DELTA === '1';
  const scrollStep = deltaScroll ? slotCells : 2;
  let shownTop = null; // top band currently on screen (delta baseline); null ⇒ unknown
  let shownSig = null; // page + geometry the on-screen frame was drawn for

  // Per-page caches. draw() runs on every keypress, but the page bytes and the
  // full-width scale are constant within a page — re-doing them per scroll step
  // (a network round-trip per step for remote sources) is what made scrolling
  // crawl. Cache both, keyed by page (and width for the scale).
  let rawKey = null;
  let rawBuf = null;
  let scaledKey = null;
  let scaledBuf = null;
  let sixelKey = null;
  let sixelPg = null;

  // Render scheduler state: coalesce bursts of keypresses into the fewest draws
  // instead of dropping input mid-draw. `inputSeq` lets a finishing draw detect
  // whether the user moved on while it was rendering.
  let inputSeq = 0;
  let drawing = false;
  let pending = false;
  let pendingFullClear = false;

  const size = () => ({
    cols: Math.max(20, stdout.columns || 80),
    rows: Math.max(6, stdout.rows || 24),
  });

  async function ensurePages() {
    if (pages) return;
    pages = await source.getPages(chapters[ci].id);
    pi = Math.max(0, Math.min(pi, pages.length - 1));
  }

  // The page bytes, fetched once per page (not per scroll step).
  async function pageBuffer() {
    const key = `${ci}:${pi}`;
    if (rawKey === key && rawBuf) return rawBuf;
    rawBuf = await source.loadPageBuffer(pages[pi]);
    rawKey = key;
    return rawBuf;
  }

  // The page scaled to full viewport width, reused across vertical scrolling.
  async function scaledPage(cols) {
    const key = `${ci}:${pi}:${cols}:${caps.cellW || ''}`;
    if (scaledKey === key && scaledBuf) return scaledBuf;
    scaledBuf = await scalePage(await pageBuffer(), { cols, cellW: caps.cellW });
    scaledKey = key;
    return scaledBuf;
  }

  // The page encoded to a sliceable sixel ONCE (palette + 6px bands), so every
  // scroll step is a band-window slice instead of a fresh chafa+sharp encode.
  async function sixelPageCached(cols) {
    const key = `${ci}:${pi}:${cols}:${caps.cellW || ''}`;
    if (sixelKey === key && sixelPg) return sixelPg;
    const scaled = await scaledPage(cols);
    sixelPg = await encodeSixelPage(scaled.buffer);
    sixelKey = key;
    return sixelPg;
  }

  function statusBar() {
    const { cols } = size();
    const left = `${manga.title} · ${chapterLabel(chapters[ci])} · ${pi + 1}/${pages ? pages.length : '?'}${fitWidth ? '' : ' · fit'}`;
    const right = '←→ page · ↑↓ pan · n/p ch · f fit · q back';
    const gap = Math.max(1, cols - left.length - right.length - 2);
    return ` ${left}${' '.repeat(gap)}${right} `.slice(0, cols);
  }

  async function draw({ fullClear = false } = {}) {
    const seq = inputSeq;
    const { cols, rows } = size();
    const imgRows = rows - 1; // reserve the bottom row for the status bar
    try {
      await ensurePages();
      if (!pages.length) throw new Error('This chapter has no hosted pages.');

      // Build the bytes for this frame (null ⇒ nothing changed, skip the write).
      // Default sixel path windows the pre-encoded page bands; with strip-scroll
      // opted in, a slot-sized move scrolls the terminal and repaints only the
      // exposed strip. 'fit'/kitty fall back to a per-frame encode.
      let frame = null;
      let imageRows = imgRows;
      let mScroll = 0;
      let sScroll = scroll;

      if (fitWidth && format === 'sixel') {
        const page = await sixelPageCached(cols);
        const viewBands = Math.max(1, Math.floor((imgRows * cellH) / 6));
        const maxStart = Math.max(0, page.bands.length - viewBands);
        let topBand = Math.round((scroll * cellH) / 6);
        if (deltaScroll) topBand = Math.round(topBand / slotBands) * slotBands;
        topBand = Math.max(0, Math.min(topBand, maxStart));

        imageRows = Math.round((viewBands * 6) / cellH);
        mScroll = (maxStart * 6) / cellH;
        sScroll = (topBand * 6) / cellH;

        const geomSig = `${ci}:${pi}:${cols}:${imgRows}`;
        const reuse = !fullClear && shownTop !== null && shownSig === geomSig;
        const delta = reuse ? topBand - shownTop : 0;

        if (reuse && delta === 0) {
          frame = null; // identical frame already on screen
        } else if (deltaScroll && reuse && delta !== 0
            && Math.abs(delta) % slotBands === 0 && Math.abs(delta) < viewBands) {
          frame = buildDeltaFrame(page, { from: shownTop, to: topBand, viewBands, imgRows, rows });
        } else {
          const win = sliceSixelPage(page, { startBand: topBand, numBands: viewBands }).sixel;
          frame = composeFull(win, { fullClear, imageRows, imgRows, rows });
        }
        shownTop = topBand;
        shownSig = geomSig;
      } else {
        shownTop = null; // delta baseline doesn't apply to this render path
        let prepared;
        if (fitWidth) {
          const page = await scaledPage(cols);
          prepared = await prepareImage(null, {
            mode: 'width', cols, rows: imgRows, scroll,
            cellW: caps.cellW, cellH: caps.cellH, scaled: page,
          });
        } else {
          prepared = await prepareImage(await pageBuffer(), {
            mode: 'fit', cols, rows: imgRows, cellW: caps.cellW, cellH: caps.cellH,
          });
        }
        imageRows = prepared.imageRows; mScroll = prepared.maxScroll; sScroll = prepared.scroll;
        const sig = `f:${ci}:${pi}:${sScroll}:${cols}:${imgRows}`;
        if (fullClear || sig !== shownSig) {
          const buf = await encodePixels(prepared.buffer, { format });
          // 'fit' images are letterboxed (top-left, smaller than the viewport), so
          // clear first or the previous full-width view shows through the margins.
          frame = composeFull(buf, { fullClear: fullClear || !fitWidth, imageRows, imgRows, rows });
          shownSig = sig;
        }
      }

      // Adopt the clamped scroll only if the user hasn't moved since this draw
      // started; otherwise the newer keypress + its coalesced redraw owns it (a
      // blind write-back here would undo input that arrived mid-render).
      if (seq === inputSeq) {
        maxScroll = mScroll;
        scroll = Math.max(0, Math.min(sScroll, mScroll));
      }

      if (frame) stdout.write(Buffer.concat([SYNC_BEGIN, frame, SYNC_END]));

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
      stdout.write(`Error: ${err.message}\r\n\r\nn/p chapter · q back\r\n`);
    }
  }

  // Whole-viewport frame: home + overwrite (no full ESC[2J each step — that
  // clear-to-blank is what made scrolling blink), erase only the rows a shorter
  // image leaves below, then the status bar. One atomic write avoids partial
  // frames and extra syscalls.
  function composeFull(sixelBuf, { fullClear, imageRows, imgRows, rows }) {
    const prefix = fullClear ? `${ESC}[2J${ESC}[H` : `${ESC}[H`;
    let suffix = imageRows < imgRows ? `${ESC}[${imageRows + 1};1H${ESC}[0J` : '';
    suffix += `${ESC}[${rows};1H${ESC}[7m${statusBar()}${ESC}[0m`;
    return Buffer.concat([Buffer.from(prefix, 'latin1'), sixelBuf, Buffer.from(suffix, 'latin1')]);
  }

  // Strip-scroll frame (opt-in): scroll the image area with the terminal and
  // repaint only the slot of sixel that scrolled into view — far less data than
  // re-sending the whole viewport. Valid only for slot-sized shifts (whole cells
  // AND whole bands), so the moved pixels stay band-aligned and there's no seam.
  // Uses LF/RI inside a DECSTBM region (the most widely supported scroll path).
  function buildDeltaFrame(page, { from, to, viewBands, imgRows, rows }) {
    const delta = to - from; // bands, a non-zero multiple of slotBands
    const dc = Math.round((Math.abs(delta) * 6) / cellH); // whole cells scrolled
    const region = `${ESC}[1;${imgRows}r`;
    const reset = `${ESC}[r`;
    const status = `${ESC}[${rows};1H${ESC}[7m${statusBar()}${ESC}[0m`;
    let head; let strip;
    if (delta > 0) {
      // content up → repaint the freed strip at the bottom
      head = `${region}${ESC}[${imgRows};1H${'\n'.repeat(dc)}${reset}${ESC}[${imgRows - dc + 1};1H`;
      strip = sliceSixelPage(page, { startBand: from + viewBands, numBands: delta }).sixel;
    } else {
      // content down → repaint the freed strip at the top
      head = `${region}${ESC}[1;1H${`${ESC}M`.repeat(dc)}${reset}${ESC}[1;1H`;
      strip = sliceSixelPage(page, { startBand: to, numBands: -delta }).sixel;
    }
    return Buffer.concat([Buffer.from(head, 'latin1'), strip, Buffer.from(status, 'latin1')]);
  }

  // Coalescing scheduler: while a draw runs, extra requests collapse into a
  // single follow-up at the latest state — input is never dropped and draws
  // never stack up behind a slow encode.
  function schedule({ fullClear = false } = {}) {
    if (fullClear) pendingFullClear = true;
    if (drawing) { pending = true; return; }
    drawing = true;
    (async () => {
      try {
        do {
          pending = false;
          const fc = pendingFullClear;
          pendingFullClear = false;
          await draw({ fullClear: fc });
        } while (pending);
      } finally {
        drawing = false;
      }
    })();
  }

  function changeChapter(delta) {
    const next = ci + delta;
    if (next < 0 || next >= chapters.length) return false;
    ci = next;
    pi = 0;
    scroll = 0;
    shownTop = null;
    pages = null;
    return true;
  }
  function nextPage() {
    if (pages && pi < pages.length - 1) { pi += 1; scroll = 0; shownTop = null; }
    else changeChapter(1);
  }
  function prevPage() {
    if (pi > 0) { pi -= 1; scroll = 0; shownTop = null; }
    else changeChapter(-1);
  }

  const prevRaw = stdin.isRaw;
  let onKey;
  // Ink leaves stdin unref'd after unmount, so a bare `await`-for-keypress won't
  // keep the process alive — it would exit the moment the first page is drawn.
  // A ref'd timer holds the event loop open until we're done.
  const keepAlive = setInterval(() => {}, 1 << 30);
  // Re-render on terminal resize so the page tracks the window size. Full clear:
  // a narrower/shorter window can leave stale pixels outside the new image.
  const onResize = () => { inputSeq += 1; schedule({ fullClear: true }); };
  try {
    await draw({ fullClear: true });
    stdout.on('resize', onResize);

    await new Promise((resolve) => {
      onKey = (data) => {
        const k = data.toString('latin1');
        const pageStep = Math.max(1, size().rows - 2);

        if (k === 'q' || k === ESC) { resolve(); return; }
        if (k === ' ') {
          // space = read-through: scroll a full page, then advance at the bottom
          if (fitWidth && scroll < maxScroll) scroll = Math.min(maxScroll, scroll + pageStep);
          else nextPage();
        } else if (k === 'd' || k === `${ESC}[C`) {
          nextPage();           // → / d : next page
        } else if (k === 'a' || k === `${ESC}[D`) {
          prevPage();           // ← / a : previous page
        } else if (k === 'j' || k === `${ESC}[B`) {
          scroll = Math.min(maxScroll, scroll + scrollStep);
        } else if (k === 'k' || k === `${ESC}[A`) {
          scroll = Math.max(0, scroll - scrollStep);
        } else if (k === 'n' || k === 'N') {
          changeChapter(1);     // n / N : next chapter
        } else if (k === 'p' || k === 'P') {
          changeChapter(-1);    // p / P : previous chapter
        } else if (k === 'f') {
          fitWidth = !fitWidth;
          scroll = 0;
          shownTop = null; shownSig = null; // render path changes → fresh baseline
        } else if (k === 'g') {
          scroll = 0;          // jump to top
        } else if (k === 'G') {
          scroll = maxScroll;  // jump to bottom
        } else {
          return; // ignore other keys without redrawing
        }
        // Update state synchronously, then coalesce the redraw — rapid repeats
        // collapse into the fewest draws instead of being dropped mid-draw.
        inputSeq += 1;
        schedule();
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

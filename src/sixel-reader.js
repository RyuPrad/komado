import { getSource } from './sources/index.js';
import { setProgress } from './state/store.js';
import { chapterLabel } from './domain/shape.js';
import { encodePixels, prepareImage, scalePage, encodeSixelPage, sliceSixelPage } from './render/sixel.js';
import { renderStatusBar, hintLine } from './render/statusbar.js';
import { tokenizeKeys } from './lib/keys.js';
import { easeToward } from './lib/motion.js';
import { logger } from './lib/logger.js';

const ESC = '\x1b';

// Synchronized-update markers (DEC private mode 2026). Wrapping a frame makes a
// supporting terminal present it atomically - so the strip-scroll's "scroll the
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
  let scroll = 0;       // current vertical pan (cells; fractional mid-animation)
  let scrollTarget = 0; // where the pan is headed - input moves THIS
  let fitWidth = true;  // full-width + vertical pan (max resolution); `f` toggles
  let pages = null;
  let maxScroll = 0;
  let closed = false;   // teardown flag - stops the animator scheduling writes

  // Scroll-feel instrumentation. Only meaningful when KOMADO_DEBUG=1 (logger
  // gates the writes); in normal use all this collapses to a few no-op field
  // touches. Per gesture we record flush time + bytes by frame kind, then emit
  // ONE summary line on settle so a glance at komado.log shows the bottleneck:
  // high p50 flush  -> lag (terminal pixel pipeline; fix = motion-quality encode)
  // few frames / big dt gaps -> chop (fix = finer steps / easing constants)
  // strip frames = 0 on xterm -> strip-scroll didn't engage (that alone = lag)
  const perf = { t0: 0, frames: 0, strip: 0, glide: 0, full: 0, flushMs: [], bytes: 0, maxFlushMs: 0 };
  function perfBegin() {
    perf.t0 = Date.now(); perf.frames = 0; perf.strip = 0; perf.glide = 0; perf.full = 0;
    perf.flushMs.length = 0; perf.bytes = 0; perf.maxFlushMs = 0;
  }
  function perfFrame(flushMs, bytes, kind) {
    perf.frames += 1;
    perf.bytes += bytes;
    if (kind === 'strip') perf.strip += 1;
    else if (kind === 'glide') perf.glide += 1;
    else perf.full += 1;
    perf.flushMs.push(flushMs);
    if (flushMs > perf.maxFlushMs) perf.maxFlushMs = flushMs;
  }
  function perfEnd(reason) {
    if (!logger.enabled || perf.frames === 0) return;
    const dur = Date.now() - perf.t0;
    const p50 = perf.flushMs.slice().sort((a, b) => a - b)[Math.floor(perf.flushMs.length / 2)];
    const avgBytes = Math.round(perf.bytes / perf.frames);
    // One line per gesture: kind breakdown (strip=cheap delta, glide=low-color
    // motion-quality, full=whole-viewport repaint), p50/max flush (lag signal),
    // avg bytes (cheap-vs-expensive frame signal), achieved fps (chop signal:
    // <30fps reads as visible stepping). `reason` is 'key' | 'wheel' | etc.
    logger.info(
      `pan ${reason}: ${dur}ms ${perf.frames}f (${perf.strip}s/${perf.glide}g/${perf.full}f) `
      + `flush p50=${p50}ms max=${perf.maxFlushMs} avgBytes=${avgBytes} `
      + `=${Math.round((perf.frames * 1000) / Math.max(1, dur))}fps`,
    );
  }

  // Cell/band geometry for strip-scrolling. Sixel bands are 6px tall; the
  // terminal scrolls by whole cells. A "slot" = LCM(6, cellH)px is the
  // smallest shift that's whole in BOTH grids - scrolling by slots lets us
  // move the on-screen pixels with the terminal and repaint only the newly-
  // exposed strip (seam-free), instead of re-sending the entire viewport.
  const cellH = caps.cellH || 20;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const slotBands = cellH / gcd(6, cellH);
  const slotCells = 6 / gcd(6, cellH);
  // Strip frames are ~10x less data than a viewport repaint - THE lag fix for
  // slow pixel pipelines (xterm over WSLg / remote X), but they rely on the
  // terminal scrolling sixel pixels together with the text. Real xterm does
  // (and sets XTERM_VERSION), so it's auto-on there; KOMADO_SCROLL_DELTA=1/0
  // forces it on/off for terminals we can't identify.
  const stripEnv = process.env.KOMADO_SCROLL_DELTA;
  const stripScroll = format === 'sixel'
    && (stripEnv === '1' || (stripEnv !== '0' && !!process.env.XTERM_VERSION));
  let shownTop = null; // top band currently on screen (delta baseline); null ⇒ unknown
  let shownSig = null; // page + geometry the on-screen frame was drawn for

  // Browser-style smooth pan (sixel path): input moves scrollTarget; a frame
  // loop eases `scroll` toward it and draws band-quantized slices, so an
  // animation frame costs a string slice, not an encode. With stripScroll the
  // glide phase additionally stays on the slot grid, so its frames become
  // cheap strip scrolls, and only the final landing is one full repaint.
  // kitty/'fit' re-encode per frame, so they keep the old discrete steps.
  const smoothPan = format === 'sixel' && process.env.KOMADO_NO_SMOOTH !== '1';
  const smoothNow = () => smoothPan && fitWidth;
  const scrollStep = stripScroll && !smoothPan ? slotCells : 2; // legacy discrete strip mode needs slot steps
  const mouseOn = process.env.KOMADO_NO_MOUSE !== '1'; // wheel = SGR mouse reports
  const TAU_MS = 80;            // easing time constant; settled in ~4τ ≈ 320ms
  const FRAME_MS = 16;          // frame budget; terminal backpressure stretches it
  const SNAP_CELLS = 3 / cellH; // half a sixel band - close enough to land
  const WHEEL_CELLS = 3;        // pan per wheel notch
  const MIN_STEP_BANDS = 2;     // don't render sub-12px ticks (fewer, meatier frames)

  // Per-page caches. draw() runs on every keypress, but the page bytes and the
  // full-width scale are constant within a page - re-doing them per scroll step
  // (a network round-trip per step for remote sources) is what made scrolling
  // crawl. Small promise-keyed LRUs (not single slots) so flipping back a page
  // is instant and the next page can be prefetched; storing PROMISES means a
  // page turn that lands mid-prefetch joins the in-flight work instead of
  // duplicating it. A rejected entry evicts itself so a retry can succeed.
  const rawCache = new Map();    // `${ci}:${pi}`                -> Promise<Buffer>
  const scaledCache = new Map(); // `${ci}:${pi}:${cols}:${cw}`  -> Promise<{buffer,width,height}>
  const sixelCache = new Map();  // `${ci}:${pi}:${cols}:${cw}`  -> Promise<parsed sixel page>
  // Separate cache for the low-color "motion-quality" glide encode. Kept apart
  // from sixelCache so a glide encode can NEVER evict the precious full-color
  // page (which is what the landing frame and the next page-open need). The two
  // share nothing: a different --colors mode produces a different palette, so
  // the parsed page objects (bands + palette) aren't reusable across tiers.
  const glideCache = new Map();  // `${ci}:${pi}:${cols}:${cw}`  -> Promise<parsed sixel page (16-color)>
  function memo(map, key, max, make) {
    let p = map.get(key);
    if (p) { map.delete(key); map.set(key, p); return p; } // refresh recency
    p = make();
    map.set(key, p);
    p.catch(() => { if (map.get(key) === p) map.delete(key); });
    while (map.size > max) map.delete(map.keys().next().value);
    return p;
  }

  // Render scheduler state: coalesce bursts of keypresses into the fewest draws
  // instead of dropping input mid-draw. `inputSeq` lets a finishing draw detect
  // whether the user moved on while it was rendering.
  let inputSeq = 0;
  let drawing = false;
  let pending = false;
  let pendingFullClear = false;
  let drawDone = Promise.resolve(); // settles when the current draw run (incl. coalesced passes) ends

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
  const pageBuffer = (p = pi) =>
    memo(rawCache, `${ci}:${p}`, 6, () => source.loadPageBuffer(pages[p]));

  // The page scaled to full viewport width, reused across vertical scrolling.
  const scaledPage = (cols, p = pi) =>
    memo(scaledCache, `${ci}:${p}:${cols}:${caps.cellW || ''}`, 3,
      async () => scalePage(await pageBuffer(p), { cols, cellW: caps.cellW }));

  // The page encoded to a sliceable sixel ONCE (palette + 6px bands), so every
  // scroll step is a band-window slice instead of a fresh chafa+sharp encode.
  const sixelPageCached = (cols, p = pi) =>
    memo(sixelCache, `${ci}:${p}:${cols}:${caps.cellW || ''}`, 3,
      async () => encodeSixelPage((await scaledPage(cols, p)).buffer));

  // Motion-quality: during an animated glide, draw low-color (16) frames so each
  // costs ~290KB not ~1.9MB through the terminal pixel pipeline - the difference
  // between ~7fps and ~40fps on a slow terminal. The landing frame snaps back to
  // full color (the page is already in sixelCache) for a crisp image at rest.
  // Opt-out in the house style (KOMADO_NO_MOTION_QUALITY=1), and only the sixel
  // fit-width path benefits - kitty/'fit' re-encode per frame already, and a
  // strip-capable terminal's glide frames are already cheap (delta strips).
  const motionQuality = format === 'sixel'
    && process.env.KOMADO_NO_MOTION_QUALITY !== '1';
  const sixelGlideCached = (cols, p = pi) =>
    memo(glideCache, `${ci}:${p}:${cols}:${caps.cellW || ''}`, 3,
      async () => encodeSixelPage((await scaledPage(cols, p)).buffer, { colors: '16' }));
  // `gliding` is set by animate() while a pan is in flight; draw() reads it to
  // pick the tier. The landing frame (scroll === scrollTarget) always uses full
  // color regardless, so the crisp image lands the instant motion stops.
  let gliding = false;

  // Warm the caches for the page the user is most likely to hit next. Runs
  // only AFTER a draw burst settles (never on the scroll hot path); the heavy
  // work happens in subprocesses/thread pools (chafa/sharp) or on the network,
  // so the input loop stays responsive. Failures are ignored - the page just
  // loads on demand as before.
  function prefetchNext() {
    if (!pages || pi + 1 >= pages.length) return;
    const p = pi + 1;
    const { cols } = size();
    if (fitWidth && format === 'sixel') {
      sixelPageCached(cols, p).catch(() => {});
      if (motionQuality) sixelGlideCached(cols, p).catch(() => {}); // warm glide tier too
    } else {
      pageBuffer(p).catch(() => {});
    }
  }

  // Fully styled (SGR inside, trailing reset) - callers just position and write.
  function statusBar() {
    return renderStatusBar({
      cols: size().cols,
      title: manga.title,
      info: chapterLabel(chapters[ci]),
      page: `${pi + 1}/${pages ? pages.length : '?'}`,
      hints: [
        { keys: 'a/d', label: 'page' },
        { keys: 'j/k', label: 'pan' },
        { keys: 'n/p', label: 'chapter' },
        { keys: 'f', label: 'fit', active: !fitWidth },
        { keys: 'q', label: 'back' },
      ],
    });
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
      // `frameKind` tags the result for instrumentation (strip = cheap delta,
      // full = whole-viewport repaint = the lag suspect on slow pixel pipelines).
      let frame = null;
      let frameKind = null;
      let imageRows = imgRows;
      let mScroll = 0;
      let sScroll = scroll;

      if (fitWidth && format === 'sixel') {
        // Motion-quality tier: while gliding (and not on the landing frame),
        // fetch the low-color page so each animation frame flushes ~290KB not
        // ~1.9MB. The landing frame (scroll === scrollTarget) uses full color.
        // Falling back to sixelPageCached if the glide encode isn't warm yet is
        // fine - it just means the first frame or two of a pan are full-color
        // before the 16-color page resolves (it's prefetched, so rarely seen).
        const tier = motionQuality && gliding && scroll !== scrollTarget ? 'g' : 'f';
        let page;
        try {
          page = tier === 'g' ? await sixelGlideCached(cols) : await sixelPageCached(cols);
        } catch {
          page = await sixelPageCached(cols); // glide encode failed -> full color
        }
        const viewBands = Math.max(1, Math.floor((imgRows * cellH) / 6));
        const maxStart = Math.max(0, page.bands.length - viewBands);
        let topBand = Math.round((scroll * cellH) / 6);
        if (stripScroll) {
          // Glide on the slot grid so consecutive frames strip-scroll; within
          // a slot of the target, land on the exact band (one full repaint).
          // Legacy discrete mode (KOMADO_NO_SMOOTH) always slot-rounds.
          const targetBand = Math.round((scrollTarget * cellH) / 6);
          if (!smoothPan || Math.abs(targetBand - topBand) >= slotBands) {
            topBand = Math.round(topBand / slotBands) * slotBands;
          }
        }
        topBand = Math.max(0, Math.min(topBand, maxStart));

        imageRows = Math.round((viewBands * 6) / cellH);
        mScroll = (maxStart * 6) / cellH;
        sScroll = (topBand * 6) / cellH;

        // Stamp the tier into the geometry signature so a tier transition
        // (glide -> full-color landing) can't delta-reuse against the wrong
        // palette baseline: it forces a clean full repaint on landing.
        const geomSig = `${tier}:${ci}:${pi}:${cols}:${imgRows}`;
        const reuse = !fullClear && shownTop !== null && shownSig === geomSig;
        const delta = reuse ? topBand - shownTop : 0;

        if (reuse && delta === 0) {
          frame = null; // identical frame already on screen
        } else if (stripScroll && reuse && delta !== 0
            && Math.abs(delta) % slotBands === 0 && Math.abs(delta) < viewBands) {
          frame = buildDeltaFrame(page, { from: shownTop, to: topBand, viewBands, imgRows, rows });
          frameKind = 'strip';
        } else {
          const win = sliceSixelPage(page, { startBand: topBand, numBands: viewBands }).sixel;
          frame = composeFull(win, { fullClear, imageRows, imgRows, rows });
          frameKind = tier === 'g' ? 'glide' : 'full';
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
          frameKind = 'full';
          shownSig = sig;
        }
      }

      // Adopt the clamped scroll only if the user hasn't moved since this draw
      // started; otherwise the newer keypress + its coalesced redraw owns it (a
      // blind write-back here would undo input that arrived mid-render).
      if (seq === inputSeq) {
        maxScroll = mScroll;
        // Smooth pan keeps the eased float authoritative - snapping it to the
        // drawn band each frame can stall the approach (ease forward < half a
        // band, quantize back, repeat). Discrete modes adopt the drawn
        // position so slot/step rounding stays normalized.
        scroll = Math.max(0, Math.min(smoothNow() ? scroll : sScroll, mScroll));
        // Geometry can shrink under the animator (resize, shorter page) -
        // rein the target in too, or it eases toward an unrenderable spot.
        scrollTarget = Math.max(0, Math.min(scrollTarget, mScroll));
      }

      // Await the flush: this is the animator's backpressure signal - a slow
      // terminal makes the next tick fire later with a larger dt, so motion
      // stays time-correct at whatever frame rate the terminal can swallow.
      // The closed check matters mid-quit: an in-flight animation draw must
      // not land a stray frame on top of the remounted Ink screen.
      if (frame && !closed) {
        // Time the flush: this is the backpressure signal AND the lag probe.
        // A flush > ~20ms steady means the terminal pixel pipeline (xterm sixel
        // parser + WSLg/X) can't keep up -> that's lag, and a motion-quality
        // encode for glide frames is the fix, not easing tweaks.
        const flushT0 = Date.now();
        const buf = Buffer.concat([SYNC_BEGIN, frame, SYNC_END]);
        await new Promise((res) => stdout.write(buf, res));
        if (frameKind) perfFrame(Date.now() - flushT0, buf.length, frameKind);
      }

      setProgress(manga.key, {
        source: sourceId,
        mangaId: manga.id,
        mangaTitle: manga.title,
        chapterId: chapters[ci].id,
        chapterNumber: chapters[ci].number,
        page: pi,
      });
      // Last page reached → push a read-marker to MangaDex (self-guarded/deduped).
      // `pages &&`: a rapid n/p runs changeChapter() (pages = null) during one of
      // this draw's awaits, after it started - guard before reading .length, or the
      // stale tail throws "Cannot read properties of null (reading 'length')".
      if (pages && pi === pages.length - 1 && source.syncChapterRead) {
        source.syncChapterRead(manga.id, chapters[ci].id);
      }
    } catch (err) {
      logger.warn('viewer draw failed', err);
      if (closed) return; // quitting - don't paint an error over the Ink screen
      scrollTarget = scroll; // halt any in-flight pan animation on the error screen
      // The screen now shows error text, not the last frame - drop the delta
      // baseline so a later draw of the same geometry repaints instead of
      // being skipped as "identical".
      shownTop = null;
      shownSig = null;
      stdout.write(`${ESC}[2J${ESC}[H${ESC}[0m`);
      const hints = hintLine([{ keys: 'n/p', label: 'chapter' }, { keys: 'q', label: 'back' }]);
      stdout.write(`${ESC}[1;38;5;203mError:${ESC}[0m ${err.message}\r\n\r\n${hints}\r\n`);
    }
  }

  // Whole-viewport frame: home + overwrite (no full ESC[2J each step - that
  // clear-to-blank is what made scrolling blink), erase only the rows a shorter
  // image leaves below, then the status bar. One atomic write avoids partial
  // frames and extra syscalls. Text parts are UTF-8: the status bar carries the
  // manga title/chapter label (arbitrary Unicode), which latin1 mangled into C1
  // control bytes (0x90 is an 8-bit DCS introducer!) on modern terminals. The
  // sixel window is pure ASCII bytes, so it's unaffected either way.
  function composeFull(sixelBuf, { fullClear, imageRows, imgRows, rows }) {
    const prefix = fullClear ? `${ESC}[2J${ESC}[H` : `${ESC}[H`;
    let suffix = imageRows < imgRows ? `${ESC}[${imageRows + 1};1H${ESC}[0J` : '';
    suffix += `${ESC}[${rows};1H${statusBar()}`;
    return Buffer.concat([Buffer.from(prefix), sixelBuf, Buffer.from(suffix)]);
  }

  // Strip-scroll frame (opt-in): scroll the image area with the terminal and
  // repaint only the slot of sixel that scrolled into view - far less data than
  // re-sending the whole viewport. Valid only for slot-sized shifts (whole cells
  // AND whole bands), so the moved pixels stay band-aligned and there's no seam.
  // Uses LF/RI inside a DECSTBM region (the most widely supported scroll path).
  function buildDeltaFrame(page, { from, to, viewBands, imgRows, rows }) {
    const delta = to - from; // bands, a non-zero multiple of slotBands
    const dc = Math.round((Math.abs(delta) * 6) / cellH); // whole cells scrolled
    const region = `${ESC}[1;${imgRows}r`;
    const reset = `${ESC}[r`;
    const status = `${ESC}[${rows};1H${statusBar()}`;
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
    // UTF-8 for the text parts (status bar glyphs) - see composeFull.
    return Buffer.concat([Buffer.from(head), strip, Buffer.from(status)]);
  }

  // Coalescing scheduler: while a draw runs, extra requests collapse into a
  // single follow-up at the latest state - input is never dropped and draws
  // never stack up behind a slow encode. `drawDone` is the run's completion
  // promise; the pan animator awaits it to pace itself to the terminal.
  function schedule({ fullClear = false } = {}) {
    if (closed) return;
    if (fullClear) pendingFullClear = true;
    if (drawing) { pending = true; return; }
    drawing = true;
    drawDone = (async () => {
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
      prefetchNext(); // input burst settled - warm the next page off the hot path
    })();
  }

  // Input moves the TARGET; smooth mode animates toward it, discrete modes
  // jump. Distances are cells, unchanged (2/keypress, ~a viewport for space).
  // `reason` tags the gesture in komado.log under KOMADO_DEBUG (key/wheel/etc).
  let gestureReason = '';
  function pan(deltaCells, reason = '') {
    gestureReason = reason || gestureReason;
    panTo(scrollTarget + deltaCells);
  }
  function panTo(cells, reason = '') {
    if (reason) gestureReason = reason;
    scrollTarget = Math.max(0, Math.min(maxScroll, cells));
    if (!smoothNow()) scroll = scrollTarget;
  }

  let animating = false;
  // Eased-pan frame loop. Each tick advances `scroll` along the exponential
  // curve and draws; awaiting drawDone paces the loop to what the terminal
  // actually swallows (slow terminal -> fewer ticks -> larger dt -> bigger
  // steps: motion stays time-correct). Holding a key extends scrollTarget
  // while the loop runs, which is what gives the glide-and-settle feel.
  function animate() {
    if (animating) return;
    animating = true;
    gliding = true;   // draw() reads this to pick the low-color motion-quality tier
    perfBegin();
    (async () => {
      let last = Date.now() - FRAME_MS; // first tick moves a full frame's worth
      let sentBand = shownTop;          // band position last handed to draw()
      try {
        while (!closed && scroll !== scrollTarget) {
          const now = Date.now();
          scroll = easeToward(scroll, scrollTarget, now - last, TAU_MS, SNAP_CELLS);
          last = now;
          const band = Math.round((scroll * cellH) / 6);
          const landed = scroll === scrollTarget;
          // Render only meaningful moves: sub-MIN_STEP ticks keep easing but
          // skip the draw, so frames are fewer and each visibly advances.
          // The landing frame always renders - and at scroll===scrollTarget it
          // selects the full-color tier, snapping crisp the instant motion ends.
          if (landed || sentBand === null || Math.abs(band - sentBand) >= MIN_STEP_BANDS) {
            sentBand = band;
            schedule();
            await drawDone;
          }
          if (closed || scroll === scrollTarget) break;
          const rest = FRAME_MS - (Date.now() - now);
          if (rest > 0) await new Promise((r) => setTimeout(r, rest));
        }
      } finally {
        animating = false;
        gliding = false;
        perfEnd(gestureReason || 'pan');
        gestureReason = '';
      }
    })();
  }

  function changeChapter(delta) {
    const next = ci + delta;
    if (next < 0 || next >= chapters.length) return false;
    ci = next;
    pi = 0;
    scroll = 0;
    scrollTarget = 0;
    shownTop = null;
    pages = null;
    return true;
  }
  function nextPage() {
    if (!pages) return; // chapter still loading - a blind advance would skip it
    if (pi < pages.length - 1) { pi += 1; scroll = 0; scrollTarget = 0; shownTop = null; }
    else changeChapter(1); // incl. a pageless chapter (pages=[]) - arrows move on
  }
  function prevPage() {
    if (!pages) return;
    if (pi > 0) { pi -= 1; scroll = 0; scrollTarget = 0; shownTop = null; }
    else changeChapter(-1);
  }

  const prevRaw = stdin.isRaw;
  let onKey;
  // Ink leaves stdin unref'd after unmount, so a bare `await`-for-keypress won't
  // keep the process alive - it would exit the moment the first page is drawn.
  // A ref'd timer holds the event loop open until we're done.
  const keepAlive = setInterval(() => {}, 1 << 30);
  // Re-render on terminal resize so the page tracks the window size. Full clear:
  // a narrower/shorter window can leave stale pixels outside the new image.
  const onResize = () => { inputSeq += 1; schedule({ fullClear: true }); };
  try {
    await draw({ fullClear: true });
    prefetchNext(); // the first draw bypasses schedule(), so warm page 2 here
    // Warm the motion-quality glide encode for the CURRENT page too, so the
    // first pan on page 1 doesn't stall on a cold 16-color chafa encode (the
    // full-color page is already cached from the draw above; the glide tier
    // is the one that's cold). No-op when motion-quality is off.
    if (motionQuality) sixelGlideCached(size().cols).catch(() => {});
    stdout.on('resize', onResize);

    await new Promise((resolve) => {
      onKey = (data) => {
        const pageStep = Math.max(1, size().rows - 2);
        // Fast autorepeat (or paste) batches several keypresses into one data
        // event - tokenize and handle each, or most of a rapid scroll is lost.
        let dirty = false;
        for (let k of tokenizeKeys(data.toString('latin1'))) {
          if (k.length === 3 && k[0] === ESC && k[1] === 'O') k = `${ESC}[${k[2]}`; // SS3 arrows → CSI

          // SGR mouse report "\x1b[<b;x;yM" (we only enable wheel-capable
          // press tracking). Wheel = button base 64/65 after dropping the
          // shift/meta/ctrl modifier bits; clicks and releases ('m') are
          // ignored. parseInt stops at the first ';'.
          if (k.startsWith(`${ESC}[<`)) {
            if (k.endsWith('M')) {
              const btn = parseInt(k.slice(3), 10) & ~28;
              if (btn === 64 || btn === 65) {
                pan(btn === 64 ? -WHEEL_CELLS : WHEEL_CELLS, btn === 64 ? 'wheel-up' : 'wheel-down');
                dirty = true;
              }
            }
            continue;
          }

          // \x03 = Ctrl+C: raw mode swallows SIGINT, so honour it as quit here.
          if (k === 'q' || k === ESC || k === '\x03') { resolve(); return; }
          if (k === ' ') {
            // space = read-through: scroll a full page, then advance at the bottom
            if (fitWidth && scrollTarget < maxScroll) pan(pageStep, 'space');
            else nextPage();
          } else if (k === 'd' || k === `${ESC}[C`) {
            nextPage();           // → / d : next page
          } else if (k === 'a' || k === `${ESC}[D`) {
            prevPage();           // ← / a : previous page
          } else if (k === 'j' || k === `${ESC}[B`) {
            pan(scrollStep, 'key-down');
          } else if (k === 'k' || k === `${ESC}[A`) {
            pan(-scrollStep, 'key-up');
          } else if (k === `${ESC}[6~`) {
            pan(pageStep, 'pgdn');        // PgDn
          } else if (k === `${ESC}[5~`) {
            pan(-pageStep, 'pgup');       // PgUp
          } else if (k === 'n' || k === 'N') {
            changeChapter(1);     // n / N : next chapter
          } else if (k === 'p' || k === 'P') {
            changeChapter(-1);    // p / P : previous chapter
          } else if (k === 'f') {
            fitWidth = !fitWidth;
            scroll = 0;
            scrollTarget = 0;
            shownTop = null; shownSig = null; // render path changes → fresh baseline
          } else if (k === 'g') {
            panTo(0, 'top');             // jump to top
          } else if (k === 'G') {
            panTo(maxScroll, 'bottom');  // jump to bottom
          } else {
            continue; // unrecognized token - doesn't dirty the frame
          }
          dirty = true;
        }
        if (!dirty) return; // nothing recognized - no redraw
        // Update targets synchronously, then draw once: discrete changes
        // coalesce into the fewest draws; an unfinished pan hands off to the
        // animator (which no-ops if it's already running). The smoothNow()
        // gate matters: discrete modes can leave scroll ≠ scrollTarget for a
        // moment (slot-rounded write-back), and animating a sub-slot gap
        // would spin without converging.
        inputSeq += 1;
        if (smoothNow() && scroll !== scrollTarget) animate();
        else schedule();
      };

      // Enter raw mode *after* the first draw - Ink's unmount restores cooked
      // mode on a deferred tick, which would otherwise leave stdin line-buffered
      // (so single keypresses never arrive).
      stdin.removeAllListeners('data');
      try { stdin.setRawMode(true); } catch { /* ignore */ }
      stdin.resume();
      stdin.ref?.();
      stdin.on('data', onKey);
      // Wheel scrolling: SGR-encoded button presses (1006 keeps coords sane on
      // wide terminals). Enabled after the listener so no report goes unread.
      if (mouseOn) stdout.write(`${ESC}[?1000h${ESC}[?1006h`);
    });
  } finally {
    closed = true; // the animator must not schedule writes past this point
    clearInterval(keepAlive);
    stdout.removeListener('resize', onResize);
    if (onKey) stdin.removeListener('data', onKey);
    try { stdin.setRawMode(prevRaw); } catch { /* ignore */ }
    stdout.write(`${mouseOn ? `${ESC}[?1006l${ESC}[?1000l` : ''}${ESC}[2J${ESC}[H${ESC}[0m`);
  }

  return { name: 'manga', params: { sourceId, manga } };
}

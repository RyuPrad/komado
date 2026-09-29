import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  source: null,
  setProgress: vi.fn(),
  encodePixels: vi.fn(),
  prepareImage: vi.fn(),
  scalePage: vi.fn(),
  encodeSixelPage: vi.fn(),
  sliceSixelPage: vi.fn(),
  renderStatusBar: vi.fn(),
  logger: { enabled: false, info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../src/sources/index.js', () => ({ getSource: () => mocks.source }));
vi.mock('../src/state/store.js', () => ({
  setProgress: (...args) => mocks.setProgress(...args),
}));
vi.mock('../src/render/sixel.js', () => ({
  encodePixels: (...args) => mocks.encodePixels(...args),
  prepareImage: (...args) => mocks.prepareImage(...args),
  scalePage: (...args) => mocks.scalePage(...args),
  encodeSixelPage: (...args) => mocks.encodeSixelPage(...args),
  sliceSixelPage: (...args) => mocks.sliceSixelPage(...args),
}));
vi.mock('../src/render/statusbar.js', () => ({
  renderStatusBar: (...args) => mocks.renderStatusBar(...args),
  hintLine: () => 'error-hints',
}));
vi.mock('../src/lib/logger.js', () => ({ logger: mocks.logger }));

const { runViewer } = await import('../src/sixel-reader.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeStdin extends EventEmitter {
  constructor() {
    super();
    this.isRaw = false;
  }

  setRawMode(value) { this.isRaw = value; }

  resume() {}

  ref() {}
}

class FakeStdout extends EventEmitter {
  constructor() {
    super();
    this.columns = 80;
    this.rows = 24;
    this.writes = [];
    this.holdNextCallback = false;
    this.heldCallbacks = [];
  }

  write(chunk, callback) {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    if (callback && this.holdNextCallback) {
      this.holdNextCallback = false;
      this.heldCallbacks.push(callback);
    } else if (callback) {
      queueMicrotask(callback);
    }
    return true;
  }

  releaseCallbacks() {
    for (const callback of this.heldCallbacks.splice(0)) callback();
  }

  text() {
    return Buffer.concat(this.writes).toString('latin1');
  }
}

const manga = { id: 'm1', key: 'test:m1', title: 'Race Test' };
const chapter = (id, number) => ({ id, number, volume: '1' });
const page = (id, index) => ({ id, index });

function parsedPage(id, kind = 'full') {
  return {
    id,
    kind,
    intro: '\x1bPq',
    raster: { pan: '1', pad: '1', ph: '80' },
    palette: '',
    bands: Array.from({ length: 120 }, () => '#0~'),
  };
}

async function waitFor(check, message = 'condition') {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${message}`);
}

let stdin;
let stdout;
let stdinSpy;
let stdoutSpy;
let oldEnv;

beforeEach(() => {
  oldEnv = {
    KOMADO_NO_SMOOTH: process.env.KOMADO_NO_SMOOTH,
    KOMADO_NO_MOTION_QUALITY: process.env.KOMADO_NO_MOTION_QUALITY,
    KOMADO_SCROLL_DELTA: process.env.KOMADO_SCROLL_DELTA,
    KOMADO_NO_MOUSE: process.env.KOMADO_NO_MOUSE,
    XTERM_VERSION: process.env.XTERM_VERSION,
  };
  process.env.KOMADO_NO_SMOOTH = '1';
  process.env.KOMADO_NO_MOTION_QUALITY = '1';
  process.env.KOMADO_SCROLL_DELTA = '0';
  process.env.KOMADO_NO_MOUSE = '1';
  delete process.env.XTERM_VERSION;

  stdin = new FakeStdin();
  stdout = new FakeStdout();
  stdinSpy = vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin);
  stdoutSpy = vi.spyOn(process, 'stdout', 'get').mockReturnValue(stdout);

  mocks.setProgress.mockReset();
  mocks.encodePixels.mockReset();
  mocks.prepareImage.mockReset();
  mocks.scalePage.mockReset().mockImplementation(async (raw, { cols }) => ({
    buffer: Buffer.from(`${raw.toString()}@${cols}`),
    width: cols,
    height: 720,
  }));
  mocks.encodeSixelPage.mockReset().mockImplementation(async (scaled, { colors } = {}) => (
    parsedPage(scaled.toString(), colors ? 'glide' : 'full')
  ));
  mocks.sliceSixelPage.mockReset().mockImplementation((encoded, { startBand, numBands }) => ({
    sixel: Buffer.from(`IMAGE:${encoded.kind}:${encoded.id}:TOP:${startBand}`),
    startBand,
    bands: encoded.bands.length,
    numBands: Math.min(numBands, encoded.bands.length),
    height: Math.min(numBands, encoded.bands.length) * 6,
  }));
  mocks.renderStatusBar.mockReset().mockImplementation(({ info, page: pageLabel }) => (
    `STATUS:${info}:${pageLabel}`
  ));
  mocks.logger.info.mockReset();
  mocks.logger.warn.mockReset();
});

afterEach(() => {
  stdinSpy.mockRestore();
  stdoutSpy.mockRestore();
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function startViewer({ chapters, pagesByChapter, caps = { sixel: true, cellW: 1, cellH: 6 } }) {
  mocks.source = {
    getPages: vi.fn(async (chapterId) => pagesByChapter[chapterId]),
    loadPageBuffer: vi.fn(async (descriptor) => Buffer.from(descriptor.id)),
    syncChapterRead: vi.fn(),
  };
  const promise = runViewer({
    sourceId: 'test',
    manga,
    chapters,
    chapterIndex: 0,
    caps,
  });
  return { promise, source: mocks.source };
}

async function readyForInput() {
  await waitFor(() => stdin.listenerCount('data') === 1, 'viewer raw-input listener');
}

async function quit(viewer) {
  stdin.emit('data', Buffer.from('q'));
  await viewer;
}

describe('pixel viewer stale draws', () => {
  it('retries the initial cold draw at the new terminal size', async () => {
    const delayed = deferred();
    mocks.encodeSixelPage.mockImplementation(async (scaled) => {
      const id = scaled.toString();
      if (id === 'p0@80') return delayed.promise;
      return parsedPage(id);
    });
    const { promise } = startViewer({
      chapters: [chapter('c1', '1')],
      pagesByChapter: { c1: [page('p0', 0)] },
    });
    await waitFor(
      () => mocks.encodeSixelPage.mock.calls.some(([buf]) => buf.toString() === 'p0@80'),
      'initial encode',
    );

    stdout.columns = 100;
    stdout.emit('resize');
    delayed.resolve(parsedPage('p0@80'));

    await readyForInput();
    await waitFor(() => stdout.text().includes('IMAGE:full:p0@100'), 'resized initial repaint');
    const resizedFrame = stdout.writes
      .map((buf) => buf.toString('latin1'))
      .find((text) => text.includes('IMAGE:full:p0@100'));
    await quit(promise);

    expect(stdout.text()).not.toContain('IMAGE:full:p0@80');
    expect(resizedFrame).toContain('\x1b[2J');
    expect(mocks.setProgress).toHaveBeenCalledTimes(1);
  });

  it('discards a delayed page draw and repaints the latest page', async () => {
    const delayed = deferred();
    mocks.encodeSixelPage.mockImplementation(async (scaled) => {
      const id = scaled.toString();
      if (id === 'p1@80') return delayed.promise;
      return parsedPage(id);
    });
    const { promise } = startViewer({
      chapters: [chapter('c1', '1')],
      pagesByChapter: { c1: [page('p0', 0), page('p1', 1), page('p2', 2)] },
    });
    await readyForInput();
    await waitFor(
      () => mocks.encodeSixelPage.mock.calls.some(([buf]) => buf.toString() === 'p1@80'),
      'page-one prefetch',
    );

    stdin.emit('data', Buffer.from('d'));
    stdin.emit('data', Buffer.from('d'));
    delayed.resolve(parsedPage('p1@80'));

    await waitFor(() => stdout.text().includes('IMAGE:full:p2@80'), 'latest-page repaint');
    const latestFrame = stdout.writes
      .map((buf) => buf.toString('latin1'))
      .find((text) => text.includes('IMAGE:full:p2@80'));
    await quit(promise);

    expect(stdout.text()).not.toContain('IMAGE:full:p1@80');
    expect(latestFrame).toContain('STATUS:Ch. 1 (Vol. 1):3/3');
    const savedPages = mocks.setProgress.mock.calls.map(([, value]) => value.page);
    expect(savedPages).toEqual([0, 2]);
  });

  it('ignores an old chapter encode after a chapter change', async () => {
    const delayed = deferred();
    mocks.encodeSixelPage.mockImplementation(async (scaled) => {
      const id = scaled.toString();
      if (id === 'c1p1@80') return delayed.promise;
      return parsedPage(id);
    });
    const { promise } = startViewer({
      chapters: [chapter('c1', '1'), chapter('c2', '2')],
      pagesByChapter: {
        c1: [page('c1p0', 0), page('c1p1', 1)],
        c2: [page('c2p0', 0)],
      },
    });
    await readyForInput();
    await waitFor(
      () => mocks.encodeSixelPage.mock.calls.some(([buf]) => buf.toString() === 'c1p1@80'),
      'old-chapter prefetch',
    );

    stdin.emit('data', Buffer.from('d'));
    stdin.emit('data', Buffer.from('n'));
    delayed.resolve(parsedPage('c1p1@80'));

    await waitFor(() => stdout.text().includes('IMAGE:full:c2p0@80'), 'new-chapter repaint');
    const currentFrame = stdout.writes.find((buf) => buf.toString().includes('IMAGE:full:c2p0@80'));
    await quit(promise);

    expect(stdout.text()).not.toContain('IMAGE:full:c1p1@80');
    expect(stdout.text()).not.toContain('Error:');
    expect(currentFrame.toString()).toContain('\x1b[2J');
    expect(mocks.setProgress.mock.calls.map(([, value]) => [value.chapterId, value.page]))
      .toEqual([['c1', 0], ['c2', 0]]);
  });

  it('does not restart chapter loading for a page key that is a semantic no-op', async () => {
    const nextPages = deferred();
    const { promise, source } = startViewer({
      chapters: [chapter('c1', '1'), chapter('c2', '2')],
      pagesByChapter: {
        c1: [page('c1p0', 0)],
        c2: nextPages.promise,
      },
    });
    await readyForInput();

    stdin.emit('data', Buffer.from('n'));
    await waitFor(
      () => source.getPages.mock.calls.filter(([id]) => id === 'c2').length === 1,
      'next chapter load',
    );
    stdin.emit('data', Buffer.from('d')); // ignored while pages === null
    nextPages.resolve([page('c2p0', 0)]);

    await waitFor(() => stdout.text().includes('IMAGE:full:c2p0@80'), 'loaded chapter repaint');
    await quit(promise);

    expect(source.getPages.mock.calls.filter(([id]) => id === 'c2')).toHaveLength(1);
  });

  it('drops an old-geometry encode when the terminal resizes', async () => {
    const delayed = deferred();
    mocks.encodeSixelPage.mockImplementation(async (scaled) => {
      const id = scaled.toString();
      if (id === 'p1@80') return delayed.promise;
      return parsedPage(id);
    });
    const { promise } = startViewer({
      chapters: [chapter('c1', '1')],
      pagesByChapter: { c1: [page('p0', 0), page('p1', 1)] },
    });
    await readyForInput();
    await waitFor(
      () => mocks.encodeSixelPage.mock.calls.some(([buf]) => buf.toString() === 'p1@80'),
      'old-width prefetch',
    );

    stdin.emit('data', Buffer.from('d'));
    stdout.columns = 100;
    stdout.emit('resize');
    delayed.resolve(parsedPage('p1@80'));

    await waitFor(() => stdout.text().includes('IMAGE:full:p1@100'), 'resized repaint');
    await quit(promise);

    expect(stdout.text()).not.toContain('IMAGE:full:p1@80');
    expect(stdout.text()).toContain('IMAGE:full:p1@100');
    expect(mocks.setProgress.mock.calls.map(([, value]) => value.page)).toEqual([0, 1]);
  });

  it('keeps a resize clear sticky when its first redraw is superseded', async () => {
    const resizedPage = deferred();
    mocks.encodeSixelPage.mockImplementation(async (scaled) => {
      const id = scaled.toString();
      if (id === 'p0@100') return resizedPage.promise;
      return parsedPage(id);
    });
    const { promise } = startViewer({
      chapters: [chapter('c1', '1')],
      pagesByChapter: { c1: [page('p0', 0), page('p1', 1)] },
    });
    await readyForInput();

    stdout.columns = 100;
    stdout.emit('resize');
    await waitFor(
      () => mocks.encodeSixelPage.mock.calls.some(([buf]) => buf.toString() === 'p0@100'),
      'first resize redraw',
    );
    stdin.emit('data', Buffer.from('d'));
    resizedPage.resolve(parsedPage('p0@100'));

    await waitFor(() => stdout.text().includes('IMAGE:full:p1@100'), 'superseding page repaint');
    const currentFrame = stdout.writes
      .map((buf) => buf.toString('latin1'))
      .find((text) => text.includes('IMAGE:full:p1@100'));
    await quit(promise);

    expect(stdout.text()).not.toContain('IMAGE:full:p0@100');
    expect(currentFrame).toContain('\x1b[2J');
    expect(mocks.setProgress.mock.calls.map(([, value]) => value.page)).toEqual([0, 1]);
  });

  it('redraws safely when a resize arrives during smooth animation', async () => {
    delete process.env.KOMADO_NO_SMOOTH;
    const { promise } = startViewer({
      chapters: [chapter('c1', '1')],
      pagesByChapter: { c1: [page('p0', 0)] },
    });
    await readyForInput();

    const mark = stdout.writes.length;
    stdin.emit('data', Buffer.from('G'));
    await waitFor(() => stdout.writes.length > mark, 'first animation frame');
    stdout.columns = 100;
    stdout.emit('resize');

    await waitFor(() => stdout.text().includes('IMAGE:full:p0@100'), 'animated resize repaint');
    const resizedFrame = stdout.writes
      .map((buf) => buf.toString('latin1'))
      .find((text) => text.includes('IMAGE:full:p0@100'));
    await quit(promise);

    expect(resizedFrame).toContain('\x1b[2J');
    expect(stdout.text()).not.toContain('Error:');
  });

  it('ignores a rejected encode after the user has moved on', async () => {
    const delayed = deferred();
    mocks.encodeSixelPage.mockImplementation(async (scaled) => {
      const id = scaled.toString();
      if (id === 'p1@80') return delayed.promise;
      return parsedPage(id);
    });
    const { promise } = startViewer({
      chapters: [chapter('c1', '1')],
      pagesByChapter: { c1: [page('p0', 0), page('p1', 1), page('p2', 2)] },
    });
    await readyForInput();
    await waitFor(
      () => mocks.encodeSixelPage.mock.calls.some(([buf]) => buf.toString() === 'p1@80'),
      'abandoned encode',
    );

    stdin.emit('data', Buffer.from('d'));
    stdin.emit('data', Buffer.from('d'));
    delayed.reject(new Error('old page failed'));

    await waitFor(() => stdout.text().includes('IMAGE:full:p2@80'), 'post-error repaint');
    await quit(promise);

    expect(stdout.text()).not.toContain('Error:');
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('does not persist a frame superseded during stdout backpressure', async () => {
    process.env.KOMADO_SCROLL_DELTA = '1';
    const { promise } = startViewer({
      chapters: [chapter('c1', '1')],
      pagesByChapter: { c1: [page('p0', 0)] },
    });
    await readyForInput();

    const mark = stdout.writes.length;
    stdout.holdNextCallback = true;
    stdin.emit('data', Buffer.from('j'));
    await waitFor(() => stdout.heldCallbacks.length === 1, 'held strip flush');
    stdin.emit('data', Buffer.from('j'));
    stdout.releaseCallbacks();

    await waitFor(
      () => stdout.writes.slice(mark).some((buf) => (
        buf.toString('latin1').includes('IMAGE:full:p0@80:TOP:2\x1b')
      )),
      'full corrective repaint',
    );
    const corrective = stdout.writes
      .slice(mark)
      .map((buf) => buf.toString('latin1'))
      .find((text) => text.includes('IMAGE:full:p0@80:TOP:2\x1b'));
    await quit(promise);

    expect(corrective).not.toContain('\x1b[1;23r');
    expect(mocks.setProgress).toHaveBeenCalledTimes(2); // initial + current, never stale middle
  });
});

describe('pixel viewer glide fallback tier', () => {
  it('forces a full repaint before reusing a later low-color palette', async () => {
    delete process.env.KOMADO_NO_SMOOTH;
    delete process.env.KOMADO_NO_MOTION_QUALITY;
    process.env.KOMADO_SCROLL_DELTA = '1';
    let glideCalls = 0;
    mocks.encodeSixelPage.mockImplementation(async (scaled, { colors } = {}) => {
      const id = scaled.toString();
      if (colors) {
        glideCalls += 1;
        // Startup prewarm and the first moving frame both fail. The next glide
        // succeeds, exercising full-fallback -> real-glide palette transition.
        if (glideCalls <= 2) throw new Error('low-color encode failed');
        return parsedPage(id, 'glide');
      }
      return parsedPage(id, 'full');
    });
    const { promise } = startViewer({
      chapters: [chapter('c1', '1')],
      pagesByChapter: { c1: [page('p0', 0)] },
    });
    await readyForInput();
    await waitFor(() => glideCalls >= 1, 'failed glide prewarm');

    const mark = stdout.writes.length;
    stdin.emit('data', Buffer.from('G'));
    await waitFor(
      () => stdout.writes.slice(mark).some((buf) => buf.toString('latin1').includes('IMAGE:glide:p0@80')),
      'successful glide frame',
    );
    const firstGlide = stdout.writes
      .slice(mark)
      .map((buf) => buf.toString('latin1'))
      .find((text) => text.includes('IMAGE:glide:p0@80'));
    await quit(promise);

    // A delta frame carries DECSTBM (ESC[1;<rows>r). The first real glide must
    // be whole-viewport because the preceding fallback used the full palette.
    expect(firstGlide).not.toContain('\x1b[1;23r');
    expect(glideCalls).toBeGreaterThanOrEqual(3);
  });
});

describe('pixel viewer image boundaries', () => {
  const realCells = { sixel: true, cellW: 10, cellH: 20 };

  it.each([18, 20])('clears a previous tall page before painting a %i-band page', async (bandCount) => {
    mocks.encodeSixelPage.mockImplementation(async (scaled) => {
      const encoded = parsedPage(scaled.toString());
      if (encoded.id === 'p1@80') encoded.bands = Array.from({ length: bandCount }, () => '#0~');
      return encoded;
    });
    const { promise } = startViewer({
      chapters: [chapter('c1', '1')],
      pagesByChapter: { c1: [page('p0', 0), page('p1', 1)] },
      caps: realCells,
    });
    await readyForInput();
    const mark = stdout.writes.length;
    stdin.emit('data', Buffer.from('d'));
    await waitFor(() => mocks.setProgress.mock.calls.some(([, value]) => value.page === 1), 'short page');
    const frame = stdout.writes.slice(mark).find((buf) => buf.toString().includes('IMAGE:full:p1@80'));
    await quit(promise);

    expect(frame.toString().startsWith('\x1b[?2026h\x1b[2J\x1b[H')).toBe(true);
    expect(frame.toString()).toContain(`\x1b[${Math.ceil(bandCount * 6 / 20) + 1};1H\x1b[0J`);
    expect(frame.toString()).toContain('\x1b[24;1HSTATUS:Ch. 1 (Vol. 1):2/2');
  });

  it('clears once when changing fit modes and erases below the occupied image cells', async () => {
    mocks.prepareImage.mockResolvedValue({
      buffer: Buffer.from('fit'), imageRows: 6, maxScroll: 0, scroll: 0,
    });
    mocks.encodePixels.mockResolvedValue(Buffer.from('FIT-IMAGE'));
    const { promise } = startViewer({
      chapters: [chapter('c1', '1')],
      pagesByChapter: { c1: [page('p0', 0)] },
      caps: realCells,
    });
    await readyForInput();
    const mark = stdout.writes.length;
    stdin.emit('data', Buffer.from('f'));
    await waitFor(() => stdout.writes.slice(mark).some((buf) => buf.toString().includes('FIT-IMAGE')), 'fit frame');
    stdin.emit('data', Buffer.from('f'));
    await waitFor(() => mocks.setProgress.mock.calls.length === 3, 'width frame');
    const frames = stdout.writes.slice(mark).map((buf) => buf.toString());
    await quit(promise);

    expect(frames.find((text) => text.includes('FIT-IMAGE'))).toContain('\x1b[7;1H\x1b[0J');
    expect(frames.filter((text) => text.includes('\x1b[2J'))).toHaveLength(2);
  });

  it('uses matching whole-cell and whole-band regions for strip scrolling in both directions', async () => {
    process.env.KOMADO_SCROLL_DELTA = '1';
    const { promise } = startViewer({
      chapters: [chapter('c1', '1')],
      pagesByChapter: { c1: [page('p0', 0)] },
      caps: realCells,
    });
    await readyForInput();
    const initial = stdout.writes.find((buf) => buf.toString().includes('IMAGE:full:p0@80'));
    const firstWindow = mocks.sliceSixelPage.mock.calls[0][1];
    const mark = stdout.writes.length;
    stdin.emit('data', Buffer.from('j'));
    await waitFor(() => mocks.setProgress.mock.calls.length === 2, 'down strip');
    stdin.emit('data', Buffer.from('k'));
    await waitFor(() => mocks.setProgress.mock.calls.length === 3, 'up strip');
    const frames = stdout.writes.slice(mark).map((buf) => buf.toString());
    await quit(promise);

    expect(firstWindow.numBands).toBe(70); // 420px = 21 cells, leaving two blank rows
    expect(initial.toString()).toContain('\x1b[22;1H\x1b[0J');
    expect(frames[0]).toContain('\x1b[1;21r\x1b[21;1H\n\n\n\x1b[r\x1b[19;1H');
    expect(frames[0]).toContain('IMAGE:full:p0@80:TOP:70');
    expect(frames[1]).toContain('\x1b[1;21r\x1b[1;1H\x1bM\x1bM\x1bM\x1b[r\x1b[1;1H');
    expect(frames.every((text) => !text.includes('\x1b[2J'))).toBe(true);
    expect(frames.every((text) => text.includes('\x1b[24;1HSTATUS:'))).toBe(true);
    expect(mocks.encodeSixelPage).toHaveBeenCalledTimes(1); // scroll remains encode-once
  });

  it('keeps all available bands when strip scrolling is disabled', async () => {
    const { promise } = startViewer({
      chapters: [chapter('c1', '1')],
      pagesByChapter: { c1: [page('p0', 0)] },
      caps: realCells,
    });
    await readyForInput();
    const firstWindow = mocks.sliceSixelPage.mock.calls[0][1];
    await quit(promise);
    expect(firstWindow.numBands).toBe(76); // 456px; no alignment cost without deltas
  });

  it('falls back to full windows when the viewport cannot fit a strip slot', async () => {
    process.env.KOMADO_SCROLL_DELTA = '1';
    stdout.rows = 6;
    const { promise } = startViewer({
      chapters: [chapter('c1', '1')],
      pagesByChapter: { c1: [page('p0', 0)] },
      caps: { sixel: true, cellW: 10, cellH: 7 },
    });
    await readyForInput();
    const mark = stdout.writes.length;
    stdin.emit('data', Buffer.from('j'));
    await waitFor(() => mocks.setProgress.mock.calls.length === 2, 'small-viewport pan');
    const frame = stdout.writes.slice(mark).find((buf) => buf.toString().includes('IMAGE:full:p0@80'));
    await quit(promise);

    expect(mocks.sliceSixelPage.mock.calls.every(([, options]) => options.numBands === 5)).toBe(true);
    expect(frame.toString()).not.toContain('\x1b[1;5r');
    expect(frame.toString()).not.toContain('\x1b[2J');
  });

  it('lands smooth strip scrolling precisely at full color without clearing pan frames', async () => {
    delete process.env.KOMADO_NO_SMOOTH;
    delete process.env.KOMADO_NO_MOTION_QUALITY;
    process.env.KOMADO_SCROLL_DELTA = '1';
    const { promise } = startViewer({
      chapters: [chapter('c1', '1')],
      pagesByChapter: { c1: [page('p0', 0)] },
      caps: realCells,
    });
    await readyForInput();
    const mark = stdout.writes.length;
    stdin.emit('data', Buffer.from('G'));
    await waitFor(
      () => stdout.writes.slice(mark).some((buf) => buf.toString().includes('IMAGE:full:p0@80:TOP:50\x1b')),
      'full-color landing',
    );
    const frames = stdout.writes.slice(mark).map((buf) => buf.toString());
    await quit(promise);

    expect(frames.every((text) => !text.includes('\x1b[2J'))).toBe(true);
    expect(frames.some((text) => text.includes('\x1b[1;21r'))).toBe(true);
    expect(frames.at(-1)).toContain('IMAGE:full:p0@80:TOP:50\x1b');
    expect(frames.at(-1)).not.toContain('\x1b[1;21r');
    expect(mocks.encodeSixelPage).toHaveBeenCalledTimes(2); // one full and one glide encode
  });
});

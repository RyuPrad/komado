import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { withTempImage } from './chafa.js';

const execFileAsync = promisify(execFile);

// Fallback cell pixel size when the terminal didn't report one.
const DEFAULT_CELL_W = 10;
const DEFAULT_CELL_H = 20;

// Encode an already-correctly-sized image to sixel at its NATIVE pixel
// resolution. --exact-size + font-ratio 1/1 makes chafa emit ~1 image px → 1
// sixel px, so the displayed size is exactly what we sized the image to - no
// dependence on chafa guessing the terminal's cell size through a pipe.
export async function encodePixels(buffer, { format = 'sixel' } = {}) {
  const { stdout } = await withTempImage(buffer, (file) =>
    execFileAsync(
      'chafa',
      ['--format', format, '--exact-size', 'on', '--font-ratio', '1/1', '--animate', 'off', file],
      { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' },
    ),
  );
  return stdout; // Buffer of sixel/kitty bytes
}

// Scale a page to the full viewport width ONCE. In 'width' mode the same scaled
// page is windowed for every vertical scroll position, so doing the decode+resize
// here (and caching the result in the caller) keeps it off the per-keypress path.
// Returns { buffer, width, height } with the real scaled pixel dimensions.
export async function scalePage(buffer, { cols, cellW }) {
  const viewW = Math.max(1, Math.round(cols * (cellW || DEFAULT_CELL_W)));
  const scaled = await sharp(buffer).resize({ width: viewW }).png().toBuffer();
  const meta = await sharp(scaled).metadata();
  return { buffer: scaled, width: meta.width || viewW, height: meta.height || 0 };
}

// Resize/crop a page to the exact viewport pixel rectangle.
//   mode 'fit'   → whole page fits inside cols×rows cells
//   mode 'width' → full terminal width, vertical window at cell offset `scroll`
// Pass a pre-scaled page (`scaled` from scalePage) in 'width' mode to skip the
// per-scroll resize; without it the page is scaled inline.
// Returns { buffer, maxScroll, scroll, imageRows } - scroll clamped to range,
// imageRows = the rendered image's height in cells (so the caller can erase any
// rows below it instead of clearing the whole screen).
export async function prepareImage(buffer, { mode, cols, rows, scroll = 0, cellW, cellH, scaled = null }) {
  const ch = cellH || DEFAULT_CELL_H;
  const viewW = Math.max(1, Math.round(cols * (cellW || DEFAULT_CELL_W)));
  const viewH = Math.max(1, Math.round(rows * ch));

  if (mode === 'fit') {
    const out = await sharp(buffer)
      .resize({ width: viewW, height: viewH, fit: 'inside', withoutEnlargement: false })
      .png()
      .toBuffer();
    const meta = await sharp(out).metadata();
    return { buffer: out, maxScroll: 0, scroll: 0, imageRows: Math.round((meta.height || viewH) / ch) };
  }

  // mode 'width': scale to full width (reuse `scaled` when scrolling), then
  // extract a vertical window.
  const page = scaled || (await scalePage(buffer, { cols, cellW }));
  const scaledH = page.height || viewH;

  const maxScrollPx = Math.max(0, scaledH - viewH);
  const maxScroll = Math.ceil(maxScrollPx / ch);
  const clamped = Math.max(0, Math.min(scroll, maxScroll));
  const top = Math.min(maxScrollPx, clamped * ch);
  const cropH = Math.max(1, Math.min(viewH, scaledH - top));

  const out = await sharp(page.buffer)
    .extract({ left: 0, top: Math.round(top), width: page.width, height: Math.round(cropH) })
    .png()
    .toBuffer();
  return { buffer: out, maxScroll, scroll: clamped, imageRows: Math.round(cropH / ch) };
}

// ---- Sliceable sixel page (smooth vertical scrolling) ----------------------
// Re-encoding the viewport on every scroll step is the real bottleneck (~90ms of
// chafa + ~50ms of sharp per frame). But sixel is laid out as a fixed palette
// defined UP FRONT followed by independent 6px-tall bands, each of which
// re-selects its own colours. So we encode the whole page to sixel ONCE, then
// window the pre-encoded bands per frame - a string slice, not a re-encode.
// (Verified against chafa 1.14: every palette entry precedes the first band and
// every band starts with a colour select, so any band range stands alone.)
const BAND_PX = 6;

export function parseSixelPage(raw) {
  const dcsStart = raw.indexOf('\x1bP');
  if (dcsStart < 0) throw new Error('no sixel DCS found in encoder output');
  const stEnd = raw.indexOf('\x1b\\', dcsStart);
  const payload = raw.slice(dcsStart, stEnd < 0 ? undefined : stEnd);

  const qi = payload.indexOf('q'); // the DCS intro (ESC P <params> q) ends at 'q'
  const intro = qi >= 0 ? payload.slice(0, qi + 1) : '\x1bPq';
  let rest = payload.slice(intro.length);

  const rasterM = rest.match(/^"(\d+);(\d+);(\d+);(\d+)/);
  const raster = rasterM
    ? { pan: rasterM[1], pad: rasterM[2], ph: rasterM[3] }
    : { pan: '1', pad: '1', ph: '0' };
  if (rasterM) rest = rest.slice(rasterM[0].length);

  // The palette is defined entirely up front; the bands follow, separated by '-'.
  const palette = rest.match(/^((?:#\d+;2;\d+;\d+;\d+)*)/)?.[1] ?? '';
  const rawBands = rest.slice(palette.length).split('-');
  while (rawBands.length && rawBands[rawBands.length - 1] === '') rawBands.pop();

  // chafa omits a band's leading colour select when it equals the previous
  // band's last colour (the register carries across '-'). For a band to be the
  // TOP of a sliced window it must re-select that colour itself, so prepend the
  // carried register wherever it's missing - making every band self-contained.
  let carry = '0'; // sixel's default colour register
  const bands = rawBands.map((b) => {
    const fixed = b.startsWith('#') ? b : `#${carry}${b}`;
    const sels = fixed.match(/#(\d+)/g);
    if (sels) carry = sels[sels.length - 1].slice(1);
    return fixed;
  });

  return { intro, raster, palette, bands, height: bands.length * BAND_PX };
}

// Encode a full page to a parsed, sliceable sixel (one chafa call per page).
export async function encodeSixelPage(buffer) {
  const raw = (await encodePixels(buffer, { format: 'sixel' })).toString('latin1');
  return parseSixelPage(raw);
}

// Compose a complete sixel image from a band window (sub-millisecond). Pv is
// rewritten to the window height; the palette/intro are reused verbatim.
// Returns { sixel: Buffer, startBand, bands } (startBand clamped to range).
export function sliceSixelPage(page, { startBand, numBands }) {
  const total = page.bands.length;
  const k = Math.max(1, Math.min(numBands, total));
  const start = Math.max(0, Math.min(startBand, total - k));
  const body = page.bands.slice(start, start + k).join('-');
  const r = page.raster;
  const str = `${page.intro}"${r.pan};${r.pad};${r.ph};${k * BAND_PX}${page.palette}${body}\x1b\\`;
  return { sixel: Buffer.from(str, 'latin1'), startBand: start, bands: total };
}

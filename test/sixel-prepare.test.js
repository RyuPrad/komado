import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { scalePage, prepareImage } from '../src/render/sixel.js';

// Synthetic pages (solid fill - only the geometry matters here).
const page = (width, height) =>
  sharp({ create: { width, height, channels: 3, background: { r: 20, g: 40, b: 60 } } })
    .png()
    .toBuffer();

const dims = async (buf) => {
  const m = await sharp(buf).metadata();
  return { width: m.width, height: m.height };
};

// 80 cols × 10px = 800px wide. `rows` is the image area the reader passes
// (terminal rows minus the status bar), 23 × 20px = 460px tall.
const VIEW = { cols: 80, rows: 23, cellW: 10, cellH: 20 };

describe('scalePage', () => {
  it('scales a page to the full viewport width and reports real dimensions', async () => {
    const scaled = await scalePage(await page(400, 2000), { cols: 80, cellW: 10 });
    expect(scaled.width).toBe(800); // 80 cols × 10px
    expect(scaled.height).toBe(4000); // 2000 × (800/400)
    expect(await dims(scaled.buffer)).toEqual({ width: 800, height: 4000 });
  });

  it('falls back to the default cell width when none is reported', async () => {
    const scaled = await scalePage(await page(400, 800), { cols: 80 });
    expect(scaled.width).toBe(800); // DEFAULT_CELL_W (10) × 80
  });
});

describe('prepareImage - width mode (the scrolling path)', () => {
  it('windows a pre-scaled page to a full-height viewport rectangle', async () => {
    const scaled = await scalePage(await page(400, 2000), { cols: 80, cellW: 10 });
    const out = await prepareImage(null, { mode: 'width', scroll: 0, scaled, ...VIEW });

    // scaledH 4000, viewH 460 → 3540px of pan = ceil(3540/20) = 177 cells.
    expect(out.maxScroll).toBe(177);
    expect(out.scroll).toBe(0);
    expect(out.imageRows).toBe(23); // full-height window == the image area
    expect(await dims(out.buffer)).toEqual({ width: 800, height: 460 });
  });

  it('clamps an out-of-range scroll to maxScroll', async () => {
    const scaled = await scalePage(await page(400, 2000), { cols: 80, cellW: 10 });
    const out = await prepareImage(null, { mode: 'width', scroll: 9999, scaled, ...VIEW });
    expect(out.scroll).toBe(out.maxScroll);
    // Still a full-height window at the bottom (no blank gap → no clear needed).
    expect(out.imageRows).toBe(23);
    expect((await dims(out.buffer)).height).toBe(460);
  });

  it('matches the inline-scale path (cache seam is transparent)', async () => {
    const raw = await page(400, 2000);
    const scaled = await scalePage(raw, { cols: 80, cellW: 10 });
    const cached = await prepareImage(null, { mode: 'width', scroll: 50, scaled, ...VIEW });
    const inline = await prepareImage(raw, { mode: 'width', scroll: 50, ...VIEW });
    expect(inline.maxScroll).toBe(cached.maxScroll);
    expect(inline.scroll).toBe(cached.scroll);
    expect(await dims(inline.buffer)).toEqual(await dims(cached.buffer));
  });
});

describe('prepareImage - fit mode', () => {
  it('fits a landscape page inside the viewport and reports a short image', async () => {
    const out = await prepareImage(await page(800, 200), { mode: 'fit', ...VIEW });
    expect(out.maxScroll).toBe(0);
    expect(out.scroll).toBe(0);
    // 800×200 fit inside 800×460 → 800×200 (10 rows): shorter than the 23-row
    // image area, so the reader erases the rows below (imageRows < imgRows).
    expect(out.imageRows).toBe(10);
    expect(out.imageRows).toBeLessThan(VIEW.rows);
    const d = await dims(out.buffer);
    expect(d.width).toBeLessThanOrEqual(800);
    expect(d.height).toBeLessThanOrEqual(460);
  });
});

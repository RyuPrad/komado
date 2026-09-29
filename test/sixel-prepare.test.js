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

  it('includes the partial final cell of a short width-mode page', async () => {
    const out = await prepareImage(await page(800, 105), { mode: 'width', ...VIEW });
    expect(await dims(out.buffer)).toEqual({ width: 800, height: 105 });
    expect(out.imageRows).toBe(6);
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

  it('does not round the last occupied cell down before erasing below', async () => {
    const out = await prepareImage(await page(800, 105), { mode: 'fit', ...VIEW });
    expect(await dims(out.buffer)).toEqual({ width: 800, height: 105 });
    expect(out.imageRows).toBe(6);
  });
});

describe('EXIF orientation', () => {
  it('orients the source before width and fit sizing', async () => {
    const raw = await sharp(await page(40, 20)).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const scaled = await scalePage(raw, { cols: 20, cellW: 1 });
    expect({ width: scaled.width, height: scaled.height }).toEqual({ width: 20, height: 40 });
    expect(await dims(scaled.buffer)).toEqual({ width: 20, height: 40 });
    const fit = await prepareImage(raw, { mode: 'fit', cols: 20, rows: 20, cellW: 1, cellH: 1 });
    expect(await dims(fit.buffer)).toEqual({ width: 10, height: 20 });
  });

  it('honors mirrored EXIF orientation in width and fit output', async () => {
    const pixels = Buffer.alloc(40 * 20 * 3);
    for (let y = 0; y < 20; y += 1) {
      for (let x = 0; x < 40; x += 1) {
        const i = (y * 40 + x) * 3;
        pixels[i] = x < 20 ? 240 : 10;
        pixels[i + 2] = x < 20 ? 10 : 240;
      }
    }
    const raw = await sharp(pixels, { raw: { width: 40, height: 20, channels: 3 } })
      .jpeg().withMetadata({ orientation: 2 }).toBuffer();
    const scaled = await scalePage(raw, { cols: 40, cellW: 1 });
    const fit = await prepareImage(raw, { mode: 'fit', cols: 40, rows: 20, cellW: 1, cellH: 1 });
    for (const out of [scaled, fit]) {
      const normalized = await sharp(out.buffer).raw().toBuffer();
      expect(normalized[0]).toBeLessThan(30); // blue right half becomes the left half
      expect(normalized[2]).toBeGreaterThan(220);
      expect(normalized[39 * 3]).toBeGreaterThan(220);
      expect(normalized[39 * 3 + 2]).toBeLessThan(30);
    }
  });
});

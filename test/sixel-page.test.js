import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import sharp from 'sharp';
import { parseSixelPage, sliceSixelPage, encodeSixelPage } from '../src/render/sixel.js';

// A hand-built two-band sixel: DCS intro, raster "Pan;Pad;Ph;Pv, two palette
// defs, then band0 `-` band1 (each band re-selects its colour), then ST.
const CRAFTED =
  '\x1bP0;0;0q' + '"1;1;4;12' + '#0;2;100;0;0#1;2;0;100;0' +
  '#0~~~~$#1BBBB' + '-' + '#0????$#1~~~~' + '\x1b\\';

describe('parseSixelPage', () => {
  it('splits intro / raster / palette / independent bands', () => {
    const p = parseSixelPage(CRAFTED);
    expect(p.intro).toBe('\x1bP0;0;0q');
    expect(p.raster).toEqual({ pan: '1', pad: '1', ph: '4' }); // Pv dropped (recomputed)
    expect(p.palette).toBe('#0;2;100;0;0#1;2;0;100;0');
    expect(p.bands).toEqual(['#0~~~~$#1BBBB', '#0????$#1~~~~']);
    expect(p.bands.every((b) => b.startsWith('#'))).toBe(true); // each stands alone
    expect(p.height).toBe(12); // 2 bands × 6px
  });
});

describe('sliceSixelPage', () => {
  it('windows a band range and rewrites Pv to the window height', () => {
    const p = parseSixelPage(CRAFTED);
    const { sixel, startBand } = sliceSixelPage(p, { startBand: 1, numBands: 1 });
    const s = sixel.toString('latin1');
    expect(startBand).toBe(1);
    expect(s.startsWith('\x1bP0;0;0q"1;1;4;6')).toBe(true); // Pv = 1 × 6
    expect(s).toContain('#0????$#1~~~~'); // band 1
    expect(s).not.toContain('$#1BBBB'); // not band 0
    expect(s.endsWith('\x1b\\')).toBe(true);
    expect(s).toContain(p.palette); // palette carried verbatim
  });

  it('clamps a window that runs past the available bands', () => {
    const p = parseSixelPage(CRAFTED);
    const { sixel, startBand } = sliceSixelPage(p, { startBand: 5, numBands: 10 });
    const s = sixel.toString('latin1');
    expect(startBand).toBe(0); // clamped: k == total, start pinned to 0
    expect(s).toContain('"1;1;4;12'); // Pv = 2 × 6, full height
  });
});

const hasChafa = (() => {
  try { execSync('command -v chafa', { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

describe.skipIf(!hasChafa)('encodeSixelPage (chafa)', () => {
  it('encodes a real page into independent, sliceable bands', async () => {
    const w = 120, h = 180, c = 3;
    const data = Buffer.alloc(w * h * c);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * c; data[i] = x % 256; data[i + 1] = y % 256; data[i + 2] = 128;
    }
    const png = await sharp(data, { raw: { width: w, height: h, channels: c } }).png().toBuffer();
    const page = await encodeSixelPage(png);

    expect(page.bands.length).toBeGreaterThan(10);
    expect(page.bands.every((b) => b.startsWith('#'))).toBe(true); // band independence
    expect(page.height).toBe(page.bands.length * 6);

    // A mid-page window is a complete, well-formed sixel image.
    const win = sliceSixelPage(page, { startBand: 5, numBands: 8 }).sixel.toString('latin1');
    expect(win.startsWith('\x1bP')).toBe(true);
    expect(win.endsWith('\x1b\\')).toBe(true);
    expect(win).toMatch(/q"\d+;\d+;\d+;48/); // Pv = 8 × 6
  });
});

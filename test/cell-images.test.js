import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { renderHalfBlock } from '../src/render/halfblock.js';
import { imageSize, renderInline } from '../src/render/image.js';
import { renderChafaSymbols } from '../src/render/chafa.js';

const mocks = vi.hoisted(() => ({ encode: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal();
  const execFile = () => {};
  execFile[Symbol.for('nodejs.util.promisify.custom')] = (...args) => mocks.encode(...args);
  return { ...original, execFile };
});

const page = (width, height) => sharp({
  create: { width, height, channels: 3, background: '#456789' },
}).png().toBuffer();

beforeEach(() => {
  mocks.encode.mockReset().mockResolvedValue({ stdout: 'XX\nXX\n' });
});

describe('cell image fit and orientation', () => {
  it('bounds tall and extreme-aspect pages by both viewport dimensions', async () => {
    for (const [width, height] of [[800, 10000], [1, 1000], [1000, 1]]) {
      const out = await renderInline(await page(width, height), {
        cols: 78, maxRows: 20, backend: 'halfblock',
      });
      expect(out.cols).toBeLessThanOrEqual(78);
      expect(out.rows).toBeLessThanOrEqual(20);
      expect(out.rows).toBeGreaterThan(0);
    }
  });

  it('uses EXIF-oriented dimensions and paints rotated pixels', async () => {
    // A red left half and blue right half become red top / blue bottom.
    const pixels = Buffer.alloc(40 * 20 * 3);
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 40; x++) pixels[(y * 40 + x) * 3 + (x < 20 ? 0 : 2)] = 255;
    }
    const image = await sharp(pixels, { raw: { width: 40, height: 20, channels: 3 } })
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).withMetadata({ orientation: 6 }).toBuffer();
    expect(await imageSize(image)).toEqual({ width: 20, height: 40 });
    const out = await renderHalfBlock(image, { cols: 20 });
    expect({ cols: out.cols, rows: out.rows }).toEqual({ cols: 20, rows: 20 });
    expect(out.lines[0]).toMatch(/38;2;25[0-5];\d;\dm/);
    expect(out.lines.at(-1)).toMatch(/38;2;\d;\d;25[0-5]m/);
  });

  it('honors mirrored EXIF orientation without swapping dimensions', async () => {
    const pixels = Buffer.from([255, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0, 255]);
    const image = await sharp(pixels, { raw: { width: 2, height: 2, channels: 3 } })
      .png().withMetadata({ orientation: 2 }).toBuffer();
    expect(await imageSize(image)).toEqual({ width: 2, height: 2 });
    const out = await renderHalfBlock(image, { cols: 2 });
    expect(out.lines[0].startsWith('\x1b[38;2;0;0;255m')).toBe(true);
  });

  it('passes normalized pixels and fit bounds to chafa', async () => {
    const image = await sharp(await page(40, 20)).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    let metadata;
    mocks.encode.mockImplementation(async (_command, args) => {
      metadata = await sharp(await readFile(args.at(-1))).metadata();
      return { stdout: 'XX\nXX\n' };
    });
    await renderChafaSymbols(image, { cols: 20, maxRows: 7 });
    expect(metadata.width).toBe(20);
    expect(metadata.height).toBe(40);
    expect(metadata.orientation).toBeUndefined();
    expect(mocks.encode.mock.calls[0][1]).toContain('20x7');
  });

  it('preserves the fit height limit when chafa fails', async () => {
    mocks.encode.mockRejectedValue(new Error('chafa failed'));
    const out = await renderInline(await page(1, 1000), { cols: 78, maxRows: 20, backend: 'chafa-symbols' });
    expect(out.rows).toBeLessThanOrEqual(20);
  });
});

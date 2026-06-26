import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { withTempImage } from './chafa.js';

const execFileAsync = promisify(execFile);

// chafa's default font ratio is 1:2, i.e. a cell is ~2x taller than wide. We use
// the same assumption to map image pixels ↔ display cells for the crop math.
const CELL_ASPECT = 2;

// Encode an image buffer to a sixel/kitty escape sequence sized to cols×rows
// CELLS. We pass --format explicitly so chafa emits pixels even though stdout is
// captured (it can't probe the terminal through a pipe). Returns raw bytes.
export async function encodePixels(buffer, { cols, rows, format = 'sixel' }) {
  const { stdout } = await withTempImage(buffer, (file) =>
    execFileAsync(
      'chafa',
      ['--format', format, '--size', `${cols}x${rows}`, '--animate', 'off', file],
      { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' },
    ),
  );
  return stdout; // Buffer
}

// Full-width view: render the page at the full column width and show a vertical
// window of `rows` cells starting at cell `scroll`, by cropping the source image
// to that window first. This keeps full horizontal resolution while panning a
// tall page. Returns { sixel, maxScroll, scroll } (scroll clamped to range).
export async function encodePixelsWindow(buffer, { cols, rows, scroll, format = 'sixel' }) {
  const meta = await sharp(buffer).metadata();
  const width = meta.width || 1;
  const height = meta.height || 1;

  const pxPerCellRow = (CELL_ASPECT * width) / cols; // source px per displayed cell-row
  const fullCellRows = Math.max(1, Math.round(height / pxPerCellRow));
  const maxScroll = Math.max(0, fullCellRows - rows);
  const clamped = Math.max(0, Math.min(scroll, maxScroll));

  const top = Math.min(height - 1, Math.round(clamped * pxPerCellRow));
  const cropH = Math.max(1, Math.min(height - top, Math.round(rows * pxPerCellRow)));

  const cropped = await sharp(buffer).extract({ left: 0, top, width, height: cropH }).toBuffer();
  const sixel = await encodePixels(cropped, { cols, rows, format });
  return { sixel, maxScroll, scroll: clamped };
}

import sharp from 'sharp';

const ESC = '\x1b';
const RESET = `${ESC}[0m`;

// Render an image buffer to terminal lines using the upper-half-block glyph (▀):
// the glyph's foreground paints the TOP half of the cell, the background the
// BOTTOM half - so each character encodes two vertical pixels at 24-bit colour.
// One column == one pixel wide, one row == two pixels tall.
export async function renderHalfBlock(buffer, { cols = 80 } = {}) {
  const targetWidth = Math.max(1, Math.min(Math.floor(cols), 400));

  const { data, info } = await sharp(buffer)
    .resize({ width: targetWidth, fit: 'inside', withoutEnlargement: false })
    .flatten({ background: '#ffffff' }) // composite any transparency onto white
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;

  const px = (x, y) => {
    const i = (y * width + x) * channels;
    if (channels === 1) { const v = data[i]; return [v, v, v]; }
    return [data[i], data[i + 1], data[i + 2]];
  };

  const lines = [];
  for (let y = 0; y < height; y += 2) {
    let line = '';
    let lastFg = null;
    let lastBg = null;
    for (let x = 0; x < width; x++) {
      const [tr, tg, tb] = px(x, y);
      const [br, bg, bb] = y + 1 < height ? px(x, y + 1) : [tr, tg, tb];
      const fg = `${tr};${tg};${tb}`;
      const bgc = `${br};${bg};${bb}`;
      // Emit colour codes only when they change - keeps lines compact.
      if (fg !== lastFg) { line += `${ESC}[38;2;${fg}m`; lastFg = fg; }
      if (bgc !== lastBg) { line += `${ESC}[48;2;${bgc}m`; lastBg = bgc; }
      line += '▀';
    }
    lines.push(line + RESET);
  }

  return { lines, cols: width, rows: lines.length };
}

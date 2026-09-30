export function truncate(str, max) {
  const s = String(str ?? '');
  if (max <= 1 || s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + '…';
}

// Metadata belongs on one terminal row. Keep source values intact and remove
// control bytes only at display boundaries, before measuring or truncating.
export function sanitizeTerminalText(str) {
  // eslint-disable-next-line no-control-regex
  return String(str ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ');
}

function charWidth(cp) {
  // Combining marks, variation selectors, ZWJ: zero cells.
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d) return 0;
  return (cp >= 0x1100 && cp <= 0x115f)   // Hangul jamo
    || (cp >= 0x2e80 && cp <= 0xa4cf)     // CJK radicals … Yi
    || (cp >= 0xac00 && cp <= 0xd7a3)     // Hangul syllables
    || (cp >= 0xf900 && cp <= 0xfaff)     // CJK compatibility
    || (cp >= 0xfe30 && cp <= 0xfe4f)     // CJK compatibility forms
    || (cp >= 0xff00 && cp <= 0xff60)     // fullwidth forms
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1faff)   // emoji
    || (cp >= 0x20000 && cp <= 0x3fffd)   // CJK extensions
    ? 2 : 1;
}

// Width in terminal CELLS, not code units: CJK/fullwidth glyphs take 2 cells,
// combining marks 0. Not full wcwidth - just the ranges manga metadata hits -
// but enough that a Japanese title doesn't undercount by half and shear a
// fixed-width layout (the viewer status bar pads/truncates by cell count).
export function displayWidth(str) {
  let w = 0;
  for (const ch of String(str ?? '')) w += charWidth(ch.codePointAt(0));
  return w;
}

// truncate(), but in display cells - never cuts a wide glyph in half.
export function truncateWidth(str, max) {
  const s = String(str ?? '');
  if (displayWidth(s) <= max) return s;
  if (max <= 1) return max === 1 ? '…' : '';
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

// Compact relative time ("3h ago") in LOCAL time, anchored to now.
export function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

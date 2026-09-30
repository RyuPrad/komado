import { displayWidth, truncateWidth, sanitizeTerminalText } from '../lib/text.js';

// The raw viewer's bottom bar: title + chapter on the left, key hints + page
// position on the right, drawn as 256-color segments instead of one
// inverse-video run. Two deliberate constraints:
// - ASCII-only chrome. The old bar's ·/←→/↑↓ glyphs come out as fallback
//   diamonds on bitmap-font xterms (a common sixel host); the keys shown
//   (a/d, j/k …) are real bindings, so nothing is lost by naming those.
// - Every cell carries an explicit fg AND bg, so the bar reads identically on
//   light and dark terminals. 38;5;n / 48;5;n is safe on any terminal modern
//   enough to have passed the sixel/kitty capability probe.

const ESC = '\x1b';
const fg = (n) => `38;5;${n}`;
const bg = (n) => `48;5;${n}`;
// Leading 0 so a segment can never inherit the previous one's bold/colors.
const seg = (params, text) => `${ESC}[0;${params}m${text}`;

const BAR_BG = 236;                            // charcoal bar
const CHIP = `1;${fg(235)};${bg(209)}`;        // coral chips: title, page position
const CHIP_LIT = `1;${fg(235)};${bg(109)}`;    // teal chip: a toggle that's ON
const INFO = `${fg(250)};${bg(BAR_BG)}`;       // chapter label
const KEY = `1;${fg(252)};${bg(BAR_BG)}`;      // hint keys
const LABEL = `${fg(244)};${bg(BAR_BG)}`;      // hint labels
const FILL = bg(BAR_BG);

// Hints as { keys, label, active? }; an active hint becomes a lit chip (the
// key that toggles a mode doubles as its indicator). Exactly `cols` cells.
export function renderStatusBar({ cols, title, info = '', page = '', hints = [] }) {
  title = sanitizeTerminalText(title);
  info = sanitizeTerminalText(info);
  page = sanitizeTerminalText(page);
  hints = hints.map((h) => ({
    ...h, keys: sanitizeTerminalText(h.keys), label: sanitizeTerminalText(h.label),
  }));
  const pageChip = ` ${page} `;
  const pageW = displayWidth(pageChip);
  const hintW = (h) => displayWidth(`${h.keys} ${h.label}`) + (h.active ? 2 : 0);
  const hintsW = hints.length
    ? hints.reduce((w, h) => w + hintW(h), 0) + 2 * (hints.length - 1)
    : 0;
  const MIN_GAP = 2;

  // When space runs short, give up in order: chapter info tail → hints →
  // title tail. The page chip always survives.
  let showHints = hints.length > 0;
  let rightW = (showHints ? hintsW + 2 : 0) + pageW;
  let titleTxt = ` ${title} `;
  let titleW = displayWidth(titleTxt);
  const infoFullW = info ? displayWidth(info) + 1 : 0; // + leading space

  let budget = cols - titleW - MIN_GAP - rightW;
  if (budget < (info ? Math.min(infoFullW, 9) : 0)) {
    showHints = false;
    rightW = pageW;
    budget = cols - titleW - MIN_GAP - rightW;
  }
  // Below ~5 useful cells the info is just a lone ellipsis - drop it instead.
  let infoTxt = info && budget >= 6 ? ` ${truncateWidth(info, budget - 1)}` : '';
  let infoW = displayWidth(infoTxt);

  const titleBudget = cols - infoW - MIN_GAP - rightW - 2;
  if (displayWidth(title) > titleBudget) {
    titleTxt = ` ${truncateWidth(title, Math.max(1, titleBudget))} `;
    titleW = displayWidth(titleTxt);
  }

  const parts = [seg(CHIP, titleTxt)];
  if (infoTxt) parts.push(seg(INFO, infoTxt));
  parts.push(seg(FILL, ' '.repeat(Math.max(0, cols - titleW - infoW - rightW))));
  if (showHints) {
    hints.forEach((h, i) => {
      if (i) parts.push(seg(FILL, '  '));
      if (h.active) parts.push(seg(CHIP_LIT, ` ${h.keys} ${h.label} `));
      else parts.push(seg(KEY, h.keys) + seg(LABEL, ` ${h.label}`));
    });
    parts.push(seg(FILL, '  '));
  }
  parts.push(seg(CHIP, pageChip));
  return parts.join('') + `${ESC}[0m`;
}

// Hints for plain (default-background) text like the viewer's error screen:
// bold keys, dim labels - attributes only, so it works on any theme.
export function hintLine(hints) {
  return hints
    .map((h) => `${ESC}[0;1m${sanitizeTerminalText(h.keys)}${ESC}[0;2m ${sanitizeTerminalText(h.label)}`)
    .join(`${ESC}[0m  `) + `${ESC}[0m`;
}

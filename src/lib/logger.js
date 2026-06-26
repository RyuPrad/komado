import fs from 'node:fs';
import { paths } from '../config.js';

// A TUI owns stdout — console.log would corrupt the Ink render. So debug output
// goes to a file, only when MANGA_TUI_DEBUG is set. Tail it with:
//   tail -f ~/.manga-tui/manga-tui.log
const enabled = !!process.env.MANGA_TUI_DEBUG;
let stream = null;

function out() {
  if (!enabled) return null;
  if (!stream) {
    try {
      fs.mkdirSync(paths.home, { recursive: true });
      stream = fs.createWriteStream(paths.logFile, { flags: 'a' });
    } catch {
      stream = null;
    }
  }
  return stream;
}

function fmt(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

function write(level, args) {
  const s = out();
  if (!s) return;
  s.write(`[${new Date().toISOString()}] ${level} ${args.map(fmt).join(' ')}\n`);
}

export const logger = {
  enabled,
  debug: (...a) => write('DEBUG', a),
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
};

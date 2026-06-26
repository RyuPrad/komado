import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { paths } from '../config.js';
import { detectCapabilities } from './detect.js';

const execFileAsync = promisify(execFile);

let dirReady = false;
async function ensureTempDir() {
  if (dirReady) return;
  await mkdir(paths.cacheDir, { recursive: true });
  dirReady = true;
}

async function withTempImage(buffer, fn) {
  await ensureTempDir();
  const file = path.join(
    paths.cacheDir,
    `chafa-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
  );
  await writeFile(file, buffer);
  try {
    return await fn(file);
  } finally {
    unlink(file).catch(() => {});
  }
}

// Cell-based symbol output (truecolor ANSI). Compatible with Ink's <Text>
// layout, so the reader can scroll it like the half-block output. We size the
// box to the image's natural aspect to avoid chafa padding the result.
export async function renderChafaSymbols(buffer, { cols = 80 } = {}) {
  const meta = await sharp(buffer).metadata();
  const aspect = (meta.height || 1) / (meta.width || 1);
  const rows = Math.max(1, Math.round((aspect * cols) / 2)); // cells are ~2x tall

  const stdout = await withTempImage(buffer, (file) =>
    execFileAsync(
      'chafa',
      ['--format', 'symbols', '--colors', 'full', '--size', `${cols}x${rows}`, file],
      { maxBuffer: 96 * 1024 * 1024 },
    ).then((r) => r.stdout),
  );

  const lines = stdout.replace(/\n+$/, '').split('\n');
  return { lines, cols, rows: lines.length };
}

// Fullscreen one-shot: print straight to the inherited TTY so chafa can probe
// the real terminal and auto-select kitty > sixel > symbols. Used by the
// reader's "high-fidelity" toggle. Returns false if chafa is unavailable.
export function spawnChafaToTerminal(file, { cols, rows } = {}) {
  if (!detectCapabilities().chafa) return false;
  const args = ['--colors', 'full'];
  if (cols && rows) args.push('--size', `${cols}x${rows}`);
  args.push(file);
  const res = spawnSync('chafa', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  return res.status === 0;
}

export { withTempImage };

#!/usr/bin/env node
import process from 'node:process';

function printHelp() {
  console.log(`manga-tui — a terminal manga reader (MangaDex + local files)

Usage:
  manga-tui                 launch the interactive reader
  manga-tui doctor          print terminal/image capabilities and config
  manga-tui render <img>    render one image (path or URL) at best fidelity
  manga-tui --version       print version
  manga-tui --help          show this help

In the reader:
  ↑/↓ or j/k   scroll        ←/→ or h/l   prev/next page
  space        page down     N / P        next/prev chapter
  f            fit-to-screen r            cycle renderer
  g / G        top / bottom  esc          back        q   quit
`);
}

async function doctor() {
  const { detectCapabilities } = await import('./render/detect.js');
  const { paths, ensureDirs } = await import('./config.js');
  const { getConfig } = await import('./state/store.js');
  ensureDirs();
  const caps = detectCapabilities();
  const cfg = getConfig();

  console.log('manga-tui doctor\n');
  console.log('Terminal:');
  console.log(`  TERM=${caps.term}  TERM_PROGRAM=${caps.termProgram || '(none)'}`);
  console.log(`  truecolor:        ${caps.truecolor}`);
  console.log(`  kitty graphics:   ${caps.kitty}`);
  console.log(`  sixel:            ${caps.sixel}`);
  console.log(`  chafa:            ${caps.chafa ? caps.chafaVersion : 'not installed'}`);
  console.log(`  inline backend:   ${caps.chafa ? 'chafa-symbols' : 'half-block'}  (config.renderer=${cfg.renderer})`);
  console.log('\nPaths:');
  console.log(`  home:     ${paths.home}`);
  console.log(`  config:   ${paths.configFile}`);
  console.log(`  progress: ${paths.progressFile}`);
  console.log(`  cache:    ${paths.cacheDir}`);
  console.log('\nConfig:');
  console.log(`  language:          ${cfg.language}`);
  console.log(`  dataSaver:         ${cfg.dataSaver}`);
  console.log(`  renderer:          ${cfg.renderer}`);
  console.log(`  contentRating:     ${cfg.contentRating.join(', ')}`);
  console.log(`  localLibraryPaths: ${cfg.localLibraryPaths.length ? cfg.localLibraryPaths.join(', ') : '(none — add in Settings)'}`);
}

async function renderCmd(target, rest) {
  if (!target) {
    console.error('usage: manga-tui render <image-path-or-url> [width]');
    process.exit(1);
  }
  const width = Number(rest[0]) || process.stdout.columns || 80;

  let buf;
  if (/^https?:/.test(target)) {
    const { fetchWithBackoff } = await import('./lib/fetchWithBackoff.js');
    const res = await fetchWithBackoff(target);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    buf = await (await import('node:fs/promises')).readFile(target);
  }

  const { detectCapabilities } = await import('./render/detect.js');
  const caps = detectCapabilities();

  if (caps.chafa && process.stdout.isTTY) {
    // Let chafa probe the real terminal and pick kitty > sixel > symbols.
    const os = await import('node:os');
    const path = await import('node:path');
    const { writeFile, unlink } = await import('node:fs/promises');
    const sharp = (await import('sharp')).default;
    const { imageSize } = await import('./render/image.js');
    const { spawnChafaToTerminal } = await import('./render/chafa.js');

    const { width: iw, height: ih } = await imageSize(buf);
    const rows = Math.max(1, Math.round(((ih / iw) * width) / 2));
    const tmp = path.join(os.tmpdir(), `manga-tui-render-${Date.now()}.png`);
    await writeFile(tmp, await sharp(buf).png().toBuffer());
    spawnChafaToTerminal(tmp, { cols: width, rows });
    await unlink(tmp).catch(() => {});
  } else {
    const { renderHalfBlock } = await import('./render/halfblock.js');
    const out = await renderHalfBlock(buf, { cols: width });
    process.stdout.write(out.lines.join('\n') + '\n');
  }
}

async function runApp() {
  const { ensureDirs } = await import('./config.js');
  ensureDirs();

  if (!process.stdout.isTTY) {
    console.error('manga-tui needs an interactive terminal (TTY). Run it directly in your terminal.');
    process.exit(1);
  }

  const { render } = await import('ink');
  const { App } = await import('./app.js');

  // Alternate screen + hidden cursor for a clean, scrollback-free experience.
  const restore = () => process.stdout.write('\x1b[?25h\x1b[?1049l');
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  process.on('exit', restore);

  const app = render(<App />, { exitOnCtrlC: true });
  try {
    await app.waitUntilExit();
  } finally {
    restore();
    process.removeListener('exit', restore);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case '--help':
    case '-h':
      return printHelp();
    case '--version':
    case '-v': {
      const { readFileSync } = await import('node:fs');
      const url = new URL('../package.json', import.meta.url);
      return console.log(JSON.parse(readFileSync(url, 'utf8')).version);
    }
    case 'doctor':
      return doctor();
    case 'render':
      return renderCmd(rest[0], rest.slice(1));
    default:
      return runApp();
  }
}

main().catch((err) => {
  process.stdout.write('\x1b[?25h\x1b[?1049l');
  console.error(err);
  process.exit(1);
});

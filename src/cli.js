#!/usr/bin/env node
import process from 'node:process';

function printHelp() {
  console.log(`komado — a terminal manga reader (MangaDex + local files)

Usage:
  komado                 launch the interactive reader
  komado doctor          print terminal/image capabilities and config
  komado render <img>    render one image (path or URL) at best fidelity
  komado --version       print version
  komado --help          show this help

On a sixel/kitty terminal, opening a chapter launches a full-resolution pixel
viewer:  ←/→ or a/d page · ↑/↓ pan · N/P chapter · f fit-width/whole-page · q back

Otherwise the in-terminal cell reader is used:
  ↑/↓ or j/k   scroll        ←/→ or h/l   prev/next page
  space        page down     N / P        next/prev chapter
  f            fit-to-screen r            cycle renderer
  g / G        top / bottom  esc          back        q   quit
`);
}

async function doctor() {
  const { detectCapabilities, probeTerminal } = await import('./render/detect.js');
  const { paths, ensureDirs } = await import('./config.js');
  const { getConfig } = await import('./state/store.js');
  ensureDirs();
  const caps = detectCapabilities();
  const cfg = getConfig();
  const probe = await probeTerminal();

  console.log('komado doctor\n');
  console.log('Terminal:');
  console.log(`  TERM=${caps.term}  TERM_PROGRAM=${caps.termProgram || '(none)'}`);
  console.log(`  truecolor:        ${caps.truecolor}`);
  if (probe.queried) {
    console.log(`  kitty graphics:   ${probe.kitty}  (probed)`);
    console.log(`  sixel:            ${probe.sixel}  (probed)`);
    if (probe.cellW || probe.cellH) {
      console.log(`  cell size:        ${probe.cellW ?? '?'}x${probe.cellH ?? '?'} px`);
    }
  } else {
    console.log(`  kitty graphics:   ${caps.kitty}  (env guess — run in a real terminal to probe)`);
    console.log(`  sixel:            ${caps.sixel}  (env guess — run in a real terminal to probe)`);
  }
  console.log(`  chafa:            ${caps.chafa ? caps.chafaVersion : 'not installed'}`);
  console.log(`  inline backend:   ${caps.chafa ? 'chafa-symbols' : 'half-block'}  (config.renderer=${cfg.renderer})`);
  if (probe.queried) {
    const protos = [probe.kitty && 'kitty', probe.sixel && 'sixel'].filter(Boolean);
    console.log(
      protos.length
        ? `\n  → Pixel graphics available (${protos.join(', ')}). Crisp rendering is possible:\n    test it with  node dist/cli.js render <some-image>`
        : '\n  → No pixel protocol detected — rendering is limited to character cells.',
    );
  }
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
    console.error('usage: komado render <image-path-or-url> [width]');
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
    const tmp = path.join(os.tmpdir(), `komado-render-${Date.now()}.png`);
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
  const { ensureDirs, paths } = await import('./config.js');
  const { appendFileSync } = await import('node:fs');
  ensureDirs();

  if (!process.stdout.isTTY) {
    console.error('komado needs an interactive terminal (TTY). Run it directly in your terminal.');
    process.exit(1);
  }

  // Always record crashes (not gated on KOMADO_DEBUG) so failures aren't lost
  // when the alt-screen is torn down.
  const logCrash = (label, err) => {
    try {
      appendFileSync(paths.logFile, `[${new Date().toISOString()}] ${label}: ${err?.stack || err}\n`);
    } catch { /* ignore */ }
  };

  // Probe the terminal for pixel-protocol support before Ink grabs stdin.
  // KOMADO_FORCE_PIXEL skips the probe (useful if detection is wrong, or for
  // exercising the viewer in a dumb terminal).
  const { detectCapabilities, probeTerminal } = await import('./render/detect.js');
  const probed = process.env.KOMADO_FORCE_PIXEL
    ? { queried: true, sixel: true, kitty: false }
    : await probeTerminal();
  const caps = { ...detectCapabilities(), ...probed };

  const { render } = await import('ink');
  const { App } = await import('./app.js');
  const { runViewer } = await import('./sixel-reader.js'); // pre-import (no mid-loop gap)

  // Alternate screen + hidden cursor for a clean, scrollback-free experience.
  const restore = () => process.stdout.write('\x1b[?25h\x1b[?1049l');
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  process.on('exit', restore);

  try {
    // Browse in Ink; when a chapter is opened on a pixel-capable terminal the
    // app requests the sixel viewer: unmount Ink → run viewer → remount Ink.
    let resumeRoute = null;
    for (;;) {
      let viewerRequest = null;
      let instance;
      const onViewer = (payload) => {
        viewerRequest = payload;
        // Defer so we don't unmount Ink in the middle of its input dispatch.
        setImmediate(() => {
          try { instance.unmount(); } catch (err) { logCrash('unmount failed', err); }
        });
      };
      instance = render(<App caps={caps} onViewer={onViewer} initialRoute={resumeRoute} />, {
        exitOnCtrlC: true,
      });

      try {
        await instance.waitUntilExit();
      } catch (err) {
        logCrash('ink exited with error', err); // don't let an Ink reject kill us
      }

      if (!viewerRequest) break; // normal quit

      process.stdin.resume(); // keep the event loop alive across the handoff
      try {
        resumeRoute = await runViewer({ ...viewerRequest, caps });
      } catch (err) {
        logCrash('viewer crashed', err);
        resumeRoute = { name: 'manga', params: { sourceId: viewerRequest.sourceId, manga: viewerRequest.manga } };
      }
    }
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

main().catch(async (err) => {
  process.stdout.write('\x1b[?25h\x1b[?1049l');
  try {
    const { appendFileSync } = await import('node:fs');
    const { paths } = await import('./config.js');
    appendFileSync(paths.logFile, `[${new Date().toISOString()}] FATAL: ${err?.stack || err}\n`);
  } catch { /* ignore */ }
  console.error(err);
  process.exit(1);
});

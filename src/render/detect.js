import { execFileSync } from 'node:child_process';

let cached = null;

// Detect terminal/image capabilities once. Conservative: we never assume a
// pixel protocol unless there's a strong signal, because the universal
// half-block path always works.
export function detectCapabilities() {
  if (cached) return cached;
  const env = process.env;
  const term = env.TERM || '';
  const termProgram = env.TERM_PROGRAM || '';

  const kitty =
    !!env.KITTY_WINDOW_ID ||
    term.includes('kitty') ||
    termProgram === 'ghostty' ||
    termProgram === 'WezTerm';

  // Sixel is hard to probe without a terminal round-trip; trust an explicit hint
  // or a couple of known sixel-first terminals.
  const sixel =
    /sixel/i.test(env.MANGA_TUI_CAPS || '') ||
    term === 'foot' || term.includes('foot') || term.includes('mlterm');

  // We always emit 24-bit colour; non-truecolor terminals degrade gracefully.
  const truecolor = env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit';

  let chafa = false;
  let chafaVersion = null;
  try {
    const out = execFileSync('chafa', ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    chafa = true;
    chafaVersion = (out.match(/version\s+([\d.]+)/i) || [])[1] || 'unknown';
  } catch {
    /* chafa not on PATH — half-block fallback */
  }

  cached = { term, termProgram, kitty, sixel, truecolor, chafa, chafaVersion };
  return cached;
}

// Inline (scrollable) reader backend. Both options produce an array of terminal
// lines, so the reader can slice a vertical window for panning.
export function pickInlineBackend(config, caps = detectCapabilities()) {
  const pref = config?.renderer || 'auto';
  if (pref === 'halfblock') return 'halfblock';
  if (pref === 'chafa') return caps.chafa ? 'chafa-symbols' : 'halfblock';
  // auto: chafa's symbol output is sharper than raw half-blocks when available.
  return caps.chafa ? 'chafa-symbols' : 'halfblock';
}

// Cycle order for the in-reader "switch renderer" key.
export const RENDERER_CYCLE = ['auto', 'halfblock', 'chafa'];

// Actively ask the terminal what it supports by emitting a kitty-graphics
// support query (APC G) + primary Device Attributes (DA1), then reading the
// replies. DA1 returns ";4" when sixel is supported; a kitty ";OK" reply means
// the kitty graphics protocol is available. Needs a real TTY on both ends.
export async function probeTerminal({ timeoutMs = 350 } = {}) {
  const { stdin, stdout } = process;
  if (!stdout.isTTY || !stdin.isTTY) return { queried: false, sixel: false, kitty: false };

  return new Promise((resolve) => {
    let buf = '';
    const prevRaw = stdin.isRaw;
    const onData = (d) => { buf += d.toString('latin1'); };

    try { stdin.setRawMode(true); } catch { /* ignore */ }
    stdin.resume();
    stdin.on('data', onData);
    stdout.write('\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[c');

    setTimeout(() => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(prevRaw); } catch { /* ignore */ }
      stdin.pause();
      // Matching raw terminal escape replies — control chars are intentional.
      // eslint-disable-next-line no-control-regex
      const kitty = /\x1b_G[^\x1b]*;OK/.test(buf);
      // eslint-disable-next-line no-control-regex
      const da = buf.match(/\x1b\[\?([0-9;]+)c/);
      const sixel = da ? da[1].split(';').includes('4') : false;
      resolve({ queried: true, sixel, kitty });
    }, timeoutMs);
  });
}

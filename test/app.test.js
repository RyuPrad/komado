import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { render } from 'ink-testing-library';
import { setConfig } from '../src/state/store.js';
import { scan } from '../src/sources/local/index.js';
import { App } from '../src/app.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lib = path.join(os.tmpdir(), `manga-tui-app-test-${process.pid}`);

beforeAll(async () => {
  fs.rmSync(lib, { recursive: true, force: true });
  const ch = path.join(lib, 'Demo Manga', 'Chapter 1');
  fs.mkdirSync(ch, { recursive: true });
  for (const n of ['1.png', '2.png']) {
    fs.writeFileSync(
      path.join(ch, n),
      await sharp({ create: { width: 40, height: 60, channels: 3, background: { r: 210, g: 210, b: 210 } } }).png().toBuffer(),
    );
  }
  // halfblock keeps rendering deterministic + free of chafa subprocesses in CI.
  setConfig({ localLibraryPaths: [lib], renderer: 'halfblock' });
  scan();
});

describe('App (ink-testing-library)', () => {
  it('renders the home menu', async () => {
    const { lastFrame, unmount } = render(<App />);
    await sleep(120);
    expect(lastFrame()).toContain('Search MangaDex');
    expect(lastFrame()).toContain('Local library');
    unmount();
  });

  it('navigates into a local manga and renders a page in the reader', async () => {
    const { lastFrame, stdin, unmount } = render(<App />);
    await sleep(100);
    stdin.write('\x1b[B'); // down
    await sleep(20);
    stdin.write('\x1b[B'); // down → Local library
    await sleep(20);
    stdin.write('\r'); // open local library
    await sleep(200);
    expect(lastFrame()).toContain('Demo Manga');

    stdin.write('\r'); // open manga
    await sleep(250);
    stdin.write('\r'); // open first chapter → reader
    await sleep(500);
    expect(lastFrame()).toMatch(/\b1\/2\b/); // page indicator
    unmount();
  });
});

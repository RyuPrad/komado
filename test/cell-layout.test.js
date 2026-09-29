import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Box, render } from 'ink';
import { UIContext } from '../src/ui-context.js';
import { ReaderScreen } from '../src/components/screens/ReaderScreen.js';
import { getInkViewport } from '../src/lib/layout.js';
import { displayWidth } from '../src/lib/text.js';

// Exercise Ink's interactive output branch even when these tests run in CI.
vi.mock('is-in-ci', () => ({ default: false }));
const mocks = vi.hoisted(() => ({ renderInline: vi.fn(), setProgress: vi.fn() }));
vi.mock('../src/sources/index.js', () => ({
  getSource: () => ({
    getPages: async () => [{ index: 0 }],
    loadPageBuffer: async () => Buffer.from('page'),
  }),
}));
vi.mock('../src/state/store.js', () => ({
  getConfig: () => ({ renderer: 'halfblock' }),
  setProgress: (...args) => mocks.setProgress(...args),
}));
vi.mock('../src/render/image.js', () => ({
  renderInline: (...args) => mocks.renderInline(...args),
  imageSize: async () => ({ width: 40, height: 80 }),
}));
vi.mock('../src/render/detect.js', () => ({
  pickInlineBackend: () => 'halfblock', RENDERER_CYCLE: ['halfblock'],
}));

class Input extends EventEmitter {
  isTTY = true;
  data = null;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read() {
    const data = this.data;
    this.data = null;
    return data;
  }
  write(data) {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  }
}

async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for terminal output');
}

function reader(dimensions) {
  const stdout = new EventEmitter();
  Object.assign(stdout, { columns: dimensions.cols, rows: dimensions.rows, isTTY: true });
  const frames = [];
  stdout.write = (value) => { frames.push(String(value)); return true; };
  const stdin = new Input();
  const stderr = new EventEmitter();
  stderr.write = () => true;
  const params = {
    sourceId: 'test', manga: { id: 'm', key: 'm', title: '日本語'.repeat(30) },
    chapters: [{ id: 'c', number: '1', title: '長いタイトル'.repeat(10) }], chapterIndex: 0,
  };
  const instance = render(
    <UIContext.Provider value={{ dimensions }}>
      <Box flexDirection="column" paddingX={getInkViewport(dimensions).paddingX}>
        <ReaderScreen params={params} />
      </Box>
    </UIContext.Provider>,
    { stdout, stdin, stderr, debug: false, exitOnCtrlC: false, patchConsole: false },
  );
  return { ...instance, stdin, stdout, frames };
}

beforeEach(() => {
  mocks.setProgress.mockReset();
  mocks.renderInline.mockReset().mockImplementation(async (_buffer, { cols }) => ({
    lines: Array.from({ length: 40 }, (_, index) => `${index % 10}${'▀'.repeat(cols - 2)}Z`), cols, rows: 40,
  }));
});

describe('cell reader terminal layout', () => {
  it('keeps the right edge and scrolls below Ink\'s full-clear threshold', async () => {
    const terminal = reader({ cols: 80, rows: 24 });
    try {
      await waitFor(() => terminal.frames.some((frame) => frame.includes('▀')));
      const initial = stripVTControlCharacters(terminal.frames.filter((frame) => frame.includes('▀')).at(-1)).trimEnd();
      expect(mocks.renderInline.mock.calls[0][1].cols).toBe(78);
      expect(initial).toContain('▀'.repeat(76) + 'Z');
      expect(initial.split('\n')).toHaveLength(23);
      expect(initial.split('\n').every((line) => displayWidth(line) <= 80)).toBe(true);
      const writes = terminal.frames.length;
      terminal.stdin.write('j');
      await waitFor(() => terminal.frames.length > writes);
      expect(terminal.frames.some((frame) => frame.includes('\x1b[2J'))).toBe(false);
    } finally {
      terminal.unmount();
      terminal.cleanup();
    }
  });

  it('uses compact chrome on short, narrow terminals', async () => {
    const terminal = reader({ cols: 16, rows: 4 });
    try {
      await waitFor(() => terminal.frames.some((frame) => frame.includes('▀')));
      const frame = stripVTControlCharacters(terminal.frames.filter((value) => value.includes('▀')).at(-1)).trimEnd();
      expect(frame.split('\n')).toHaveLength(3);
      expect(frame.split('\n').every((line) => displayWidth(line) <= 16)).toBe(true);
      const writes = terminal.frames.length;
      terminal.stdin.write(' ');
      await waitFor(() => terminal.frames.slice(writes).some((value) => value.includes(`1${'▀'.repeat(12)}Z`)));
      const scrolled = terminal.frames.length;
      terminal.stdin.write('\x1b[5~');
      await waitFor(() => terminal.frames.slice(scrolled).some((value) => value.includes(`0${'▀'.repeat(12)}Z`)));
      expect(terminal.frames.some((value) => value.includes('\x1b[2J'))).toBe(false);
    } finally {
      terminal.unmount();
      terminal.cleanup();
    }
  });

  it('shows a resize hint without rendering pages below the usable size', async () => {
    const terminal = reader({ cols: 80, rows: 3 });
    try {
      await waitFor(() => terminal.frames.some((frame) => frame.includes('Resize terminal')));
      expect(mocks.renderInline).not.toHaveBeenCalled();
      expect(mocks.setProgress).not.toHaveBeenCalled();
    } finally {
      terminal.unmount();
      terminal.cleanup();
    }
  });
});

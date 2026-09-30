import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { UIContext } from '../src/ui-context.js';
import { SettingsScreen } from '../src/components/screens/SettingsScreen.js';

const ctx = { setTyping: () => {}, dimensions: { cols: 80, rows: 24 } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('SettingsScreen', () => {
  it('keeps a short terminal menu bounded and its final action reachable', async () => {
    const dimensions = { cols: 80, rows: 8 };
    const { lastFrame, stdin, stdout, unmount } = render(
      <UIContext.Provider value={{ ...ctx, dimensions }}>
        <Box paddingX={1} flexDirection="column"><SettingsScreen /></Box>
      </UIContext.Provider>,
    );
    Object.defineProperty(stdout, 'columns', { value: 80 });
    stdout.emit('resize');
    try {
      await sleep(80);
      expect(lastFrame().split('\n').length).toBeLessThanOrEqual(7);
      stdin.write('G');
      await sleep(40);
      expect(lastFrame()).toContain('Uninstall komado');
      expect(lastFrame().split('\n').length).toBeLessThanOrEqual(7);
    } finally {
      unmount();
    }
  });

  it('renders without an infinite render loop', async () => {
    // React logs "Maximum update depth exceeded" via console.error when a child
    // effect setState-loops (the SettingsScreen × List regression). Capture it.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { lastFrame, unmount } = render(
      <UIContext.Provider value={ctx}>
        <SettingsScreen />
      </UIContext.Provider>,
    );
    await sleep(150);
    const frame = lastFrame();
    const errors = errSpy.mock.calls.map((c) => String(c[0]));
    unmount();
    errSpy.mockRestore();

    expect(errors.some((m) => /Maximum update depth/.test(m))).toBe(false);
    expect(frame).toContain('Renderer');
    expect(frame).toContain('Settings');
  });

  it('shows the type-to-confirm prompt when Uninstall is selected', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { lastFrame, stdin, unmount } = render(
      <UIContext.Provider value={ctx}>
        <SettingsScreen />
      </UIContext.Provider>,
    );
    await sleep(80);
    stdin.write('G');   // jump to the last row - "Uninstall komado…"
    await sleep(30);
    stdin.write('\r');  // select it → confirmation (does NOT delete anything)
    await sleep(80);
    const frame = lastFrame();
    const errors = errSpy.mock.calls.map((c) => String(c[0]));
    unmount();
    errSpy.mockRestore();

    expect(errors.some((m) => /Maximum update depth/.test(m))).toBe(false);
    expect(frame).toContain('Uninstall komado');
    expect(frame).toContain('to confirm');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { UIContext } from '../src/ui-context.js';
import { LoginScreen } from '../src/components/screens/LoginScreen.js';

const ctx = { setTyping: () => {}, goBack: () => {}, dimensions: { cols: 80, rows: 24 } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('LoginScreen', () => {
  it('renders the personal-client form without crashing or looping', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { lastFrame, unmount } = render(
      <UIContext.Provider value={ctx}>
        <LoginScreen />
      </UIContext.Provider>,
    );
    await sleep(80);
    const frame = lastFrame();
    const errors = errSpy.mock.calls.map((c) => String(c[0]));
    unmount();
    errSpy.mockRestore();

    expect(errors.some((m) => /Maximum update depth/.test(m))).toBe(false);
    expect(frame).toContain('Log in to MangaDex');
    expect(frame).toContain('Client ID');
    expect(frame).toContain('Password');
  });
});

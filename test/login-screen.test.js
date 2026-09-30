import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { UIContext } from '../src/ui-context.js';
import { LoginScreen } from '../src/components/screens/LoginScreen.js';

const mocks = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock('../src/sources/mangadex/auth.js', () => ({ login: (...args) => mocks.login(...args) }));
beforeEach(() => mocks.login.mockReset());
afterEach(() => vi.restoreAllMocks());

const ctx = { setTyping: () => {}, goBack: () => {}, dimensions: { cols: 80, rows: 24 } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fillForm(stdin) {
  await sleep(30);
  for (let i = 0; i < 4; i += 1) {
    stdin.write(`field${i}`);
    await sleep(15);
    stdin.write('\r');
    await sleep(15);
  }
}

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

  it('cancels a busy login with Escape and ignores its eventual success', async () => {
    let resolve;
    mocks.login.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const goBack = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      <UIContext.Provider value={{ ...ctx, goBack }}><LoginScreen /></UIContext.Provider>,
    );
    await fillForm(stdin);
    expect(mocks.login).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain('Signing in');
    const signal = mocks.login.mock.calls[0][1].signal;
    stdin.write('\x1b');
    await sleep(20);
    expect(signal.aborted).toBe(true);
    expect(goBack).toHaveBeenCalledTimes(1);
    resolve(true);
    await sleep(20);
    expect(goBack).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('aborts an unmounted login and ignores a late error', async () => {
    let reject;
    mocks.login.mockImplementation(() => new Promise((_, r) => { reject = r; }));
    const goBack = vi.fn();
    const { stdin, unmount } = render(
      <UIContext.Provider value={{ ...ctx, goBack }}><LoginScreen /></UIContext.Provider>,
    );
    await fillForm(stdin);
    const signal = mocks.login.mock.calls[0][1].signal;
    unmount();
    expect(signal.aborted).toBe(true);
    reject(new Error('late failure'));
    await sleep(20);
    expect(goBack).not.toHaveBeenCalled();
  });

  it('ignores success immediately after unmounting a busy form', async () => {
    let resolve;
    mocks.login.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const goBack = vi.fn();
    const { stdin, unmount } = render(
      <UIContext.Provider value={{ ...ctx, goBack }}><LoginScreen /></UIContext.Provider>,
    );
    await fillForm(stdin);
    unmount();
    resolve(true);
    await sleep(20);
    expect(goBack).not.toHaveBeenCalled();
  });
});

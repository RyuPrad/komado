import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { UIContext } from '../src/ui-context.js';
import { displayWidth } from '../src/lib/text.js';
import { createCache } from '../src/lib/cache.js';

const mocks = vi.hoisted(() => ({
  source: { label: 'Fixture catalog', search: vi.fn(), getFollows: vi.fn() },
}));
vi.mock('../src/sources/index.js', () => ({ getSource: () => mocks.source }));

const { SearchScreen } = await import('../src/components/screens/SearchScreen.js');
const { LibraryScreen } = await import('../src/components/screens/LibraryScreen.js');

const views = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await sleep(5);
  }
  throw new Error('timed out waiting for condition');
}
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const page = (prefix, offset, limit, total, count = Math.min(limit, total - offset)) => ({
  data: Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${offset + i}`, key: `fixture:${prefix}${offset + i}`,
    title: `${prefix} Manga ${offset + i}`, source: 'fixture', status: 'ongoing',
  })),
  pagination: { offset, limit, total, hasMore: offset + limit < total },
});
function mount(Screen, params, dimensions = { cols: 80, rows: 24 }) {
  const navigate = vi.fn();
  const view = render(
    <UIContext.Provider value={{ navigate, setTyping: () => {}, dimensions }}>
      <Screen params={params} />
    </UIContext.Provider>,
  );
  views.push(view);
  return { ...view, navigate };
}
async function key(view, input) {
  view.stdin.write(input);
  await sleep(25);
}

beforeEach(() => {
  mocks.source.search.mockReset();
  mocks.source.getFollows.mockReset();
});
afterEach(() => {
  for (const view of views.splice(0)) view.unmount();
});

describe('SearchScreen request ownership and selection', () => {
  it('starts a fresh query at result one after navigating several pages', async () => {
    mocks.source.search.mockImplementation(async (query, { offset, limit }) => page(query || 'old', offset, limit, 60));
    const view = mount(SearchScreen, { sourceId: 'fixture', mode: 'browse' });
    await waitFor(() => view.lastFrame().includes('old Manga 0'));
    await key(view, 'G');
    await waitFor(() => mocks.source.search.mock.calls.length === 2);
    await key(view, 'G');
    await waitFor(() => mocks.source.search.mock.calls.length === 3);
    await key(view, '/');
    await key(view, 'new');
    await key(view, '\r');
    await waitFor(() => view.lastFrame().includes('new Manga 0'));
    await key(view, '\r');
    expect(view.navigate).toHaveBeenCalledWith('manga', expect.objectContaining({
      manga: expect.objectContaining({ id: 'new0' }),
    }));
    expect(mocks.source.search.mock.calls.filter(([query]) => query === 'new')).toHaveLength(1);
  });

  it('resets selection on submitting the same query again', async () => {
    mocks.source.search.mockImplementation(async (query, { offset, limit }) => page(query || 'old', offset, limit, 20));
    const view = mount(SearchScreen, { sourceId: 'fixture', mode: 'browse' });
    await waitFor(() => view.lastFrame().includes('old Manga 0'));
    await key(view, 'G');
    await key(view, '/');
    await key(view, '\r');
    await waitFor(() => mocks.source.search.mock.calls.length === 2);
    await key(view, '\r');
    expect(view.navigate.mock.calls[0][1].manga.id).toBe('old0');
  });

  it('aborts replaced same-query calls and ignores their late responses', async () => {
    const first = deferred();
    const second = deferred();
    mocks.source.search.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = mount(SearchScreen, { sourceId: 'fixture', mode: 'browse' });
    await waitFor(() => mocks.source.search.mock.calls.length === 1);
    await key(view, '/');
    await key(view, '\r');
    await waitFor(() => mocks.source.search.mock.calls.length === 2);
    expect(mocks.source.search.mock.calls[0][1].signal.aborted).toBe(true);
    expect(mocks.source.search.mock.calls[1][1].signal.aborted).toBe(false);
    first.resolve(page('stale', 0, 20, 20));
    await sleep(25);
    expect(view.lastFrame()).not.toContain('stale Manga');
    second.resolve(page('current', 0, 20, 20));
    await waitFor(() => view.lastFrame().includes('current Manga 0'));
  });

  it('rechecks near-end pagination after loading completes', async () => {
    const first = deferred();
    mocks.source.search.mockReturnValueOnce(first.promise).mockResolvedValueOnce(page('small', 2, 2, 4));
    const view = mount(SearchScreen, { sourceId: 'fixture', mode: 'browse' });
    await waitFor(() => mocks.source.search.mock.calls.length === 1);
    first.resolve(page('small', 0, 2, 4));
    await waitFor(() => mocks.source.search.mock.calls.length === 2);
    expect(mocks.source.search.mock.calls[1][1].offset).toBe(2);
    await sleep(30);
    expect(mocks.source.search).toHaveBeenCalledTimes(2);
    expect(view.lastFrame()).toContain('small Manga 0');
  });

  it('lets a same-query replacement join the cached load after canceling its first waiter', async () => {
    const pending = deferred();
    const loader = vi.fn(() => pending.promise);
    const cache = createCache();
    mocks.source.search.mockImplementation((query, { offset, signal }) =>
      cache.wrap(`${query}:${offset}`, loader, undefined, { signal }));
    const view = mount(SearchScreen, { sourceId: 'fixture', mode: 'browse' });
    await waitFor(() => loader.mock.calls.length === 1);
    await key(view, '/');
    await key(view, '\r');
    await waitFor(() => mocks.source.search.mock.calls.length === 2);
    expect(mocks.source.search.mock.calls[0][1].signal.aborted).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);
    pending.resolve(page('shared', 0, 20, 20));
    await waitFor(() => view.lastFrame().includes('shared Manga 0'));
    expect(view.lastFrame()).not.toContain('retry');
    expect(cache.get(':0').data[0].id).toBe('shared0');
  });

  it('keeps a long editable query inside its single reserved row', async () => {
    const view = mount(SearchScreen, { sourceId: 'fixture', mode: 'search' }, { cols: 28, rows: 8 });
    await sleep(25);
    await key(view, '日本語'.repeat(30));
    const lines = view.lastFrame().split('\n');
    expect(lines.length).toBeLessThanOrEqual(7);
    expect(lines.every((line) => displayWidth(line) <= 26)).toBe(true);
    expect(mocks.source.search).not.toHaveBeenCalled();
  });
});

describe.each([
  ['search', SearchScreen, 'search', 20],
  ['library', LibraryScreen, 'getFollows', 32],
])('%s pagination recovery', (_name, Screen, method, limit) => {
  const params = { sourceId: 'fixture', mode: 'browse' };
  const argsAt = (index) => mocks.source[method].mock.calls[index][method === 'search' ? 1 : 0];

  it('keeps loaded rows selectable and retries the failed append once', async () => {
    mocks.source[method]
      .mockResolvedValueOnce(page('saved', 0, limit, limit * 2))
      .mockRejectedValueOnce(new Error('temporary next-page failure'))
      .mockResolvedValueOnce(page('saved', limit, limit, limit * 2));
    const view = mount(Screen, params);
    await waitFor(() => view.lastFrame().includes('saved Manga 0'));
    await key(view, 'G');
    await waitFor(() => view.lastFrame().includes('temporary next-page failure'));
    expect(view.lastFrame()).toContain(`saved Manga ${limit - 1}`);
    await key(view, '\r');
    expect(view.navigate.mock.calls[0][1].manga.id).toBe(`saved${limit - 1}`);
    await sleep(40);
    expect(mocks.source[method]).toHaveBeenCalledTimes(2);
    await key(view, 'r');
    await waitFor(() => mocks.source[method].mock.calls.length === 3);
    expect(argsAt(2).offset).toBe(limit);
    await key(view, '\r');
    expect(view.navigate.mock.calls[1][1].manga.id).toBe(`saved${limit - 1}`);
    await key(view, 'G');
    await key(view, '\r');
    expect(view.navigate.mock.calls[2][1].manga.id).toBe(`saved${limit * 2 - 1}`);
    expect(mocks.source[method]).toHaveBeenCalledTimes(3);
  });

  it('supports retrying an initial failure without an automatic retry loop', async () => {
    mocks.source[method].mockRejectedValueOnce(new Error('initial failure')).mockResolvedValueOnce(page('retry', 0, limit, 3));
    const view = mount(Screen, params);
    await waitFor(() => view.lastFrame().includes('initial failure'));
    await sleep(40);
    expect(mocks.source[method]).toHaveBeenCalledTimes(1);
    await key(view, 'r');
    await waitFor(() => view.lastFrame().includes('retry Manga 0'));
    expect(argsAt(1).offset).toBe(0);
    await key(view, '\r');
    expect(view.navigate.mock.calls[0][1].manga.id).toBe('retry0');
  });

  it('aborts pending work when leaving the screen', async () => {
    const pending = deferred();
    mocks.source[method].mockReturnValueOnce(pending.promise);
    const view = mount(Screen, params);
    await waitFor(() => mocks.source[method].mock.calls.length === 1);
    view.unmount();
    expect(argsAt(0).signal.aborted).toBe(true);
    pending.reject(new Error('late failure from ignored cancellation'));
    await sleep(20);
    expect(view.navigate).not.toHaveBeenCalled();
  });

  it('fits CJK rows and append errors inside a short narrow viewport', async () => {
    const first = page('日本語の長いタイトル', 0, limit, limit * 2);
    mocks.source[method].mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('a very long append failure message'));
    const view = mount(Screen, params, { cols: 28, rows: 8 });
    await waitFor(() => view.lastFrame().includes('日本語'));
    await key(view, 'G');
    await waitFor(() => view.lastFrame().includes('r retry'));
    const lines = view.lastFrame().split('\n');
    expect(lines.length).toBeLessThanOrEqual(7);
    expect(lines.every((line) => displayWidth(line) <= 26)).toBe(true);
    await key(view, '\r');
    expect(view.navigate.mock.calls[0][1].manga.id).toBe(`日本語の長いタイトル${limit - 1}`);
  });
});

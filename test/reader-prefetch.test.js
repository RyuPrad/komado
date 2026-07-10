import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { UIContext } from '../src/ui-context.js';

const mocks = vi.hoisted(() => ({
  getPages: vi.fn(),
  loadPageBuffer: vi.fn(),
  renderInline: vi.fn(),
  setProgress: vi.fn(),
}));

vi.mock('../src/sources/index.js', () => ({
  getSource: () => ({
    getPages: (...args) => mocks.getPages(...args),
    loadPageBuffer: (...args) => mocks.loadPageBuffer(...args),
  }),
}));
vi.mock('../src/state/store.js', () => ({
  getConfig: () => ({ renderer: 'halfblock' }),
  setProgress: (...args) => mocks.setProgress(...args),
}));
vi.mock('../src/render/image.js', () => ({
  renderInline: (...args) => mocks.renderInline(...args),
  imageSize: vi.fn(),
}));
vi.mock('../src/render/detect.js', () => ({
  pickInlineBackend: () => 'halfblock',
  RENDERER_CYCLE: ['auto', 'halfblock'],
}));

const { ReaderScreen } = await import('../src/components/screens/ReaderScreen.js');

const pages = [{ index: 0 }, { index: 1 }];
const params = {
  sourceId: 'test',
  manga: { id: 'm1', key: 'test:m1', title: 'Test Manga' },
  chapters: [{ id: 'c1', number: '1', volume: '1' }],
  chapterIndex: 0,
  startPage: 0,
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(check) {
  for (let i = 0; i < 50; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}

function renderReader(readerParams = params) {
  return render(
    <UIContext.Provider value={{ dimensions: { cols: 80, rows: 24 } }}>
      <ReaderScreen params={readerParams} />
    </UIContext.Provider>,
  );
}

beforeEach(() => {
  mocks.getPages.mockReset().mockResolvedValue(pages);
  mocks.loadPageBuffer.mockReset();
  mocks.renderInline.mockReset().mockImplementation(async (buf) => ({
    lines: [`rendered-${buf.toString()}`],
  }));
  mocks.setProgress.mockReset();
});

describe('ReaderScreen prefetch', () => {
  it('joins an in-flight prefetched render when the user reaches that page', async () => {
    const pageB = deferred();
    mocks.loadPageBuffer.mockImplementation((page) => (
      page.index === 0 ? Promise.resolve(Buffer.from('A')) : pageB.promise
    ));
    const { lastFrame, stdin, unmount } = renderReader();
    await waitFor(() => mocks.loadPageBuffer.mock.calls.some(([page]) => page.index === 1));

    stdin.write('l');
    await new Promise((resolve) => setTimeout(resolve, 10));
    pageB.resolve(Buffer.from('B'));
    await waitFor(() => lastFrame().includes('rendered-B'));
    unmount();

    const pageBLoads = mocks.loadPageBuffer.mock.calls.filter(([page]) => page.index === 1);
    const pageBRenders = mocks.renderInline.mock.calls.filter(([buf]) => buf.toString() === 'B');
    expect(pageBLoads).toHaveLength(1);
    expect(pageBRenders).toHaveLength(1);
    expect(lastFrame()).toMatch(/\b2\/2\b/);
  });

  it('evicts a rejected prefetch so the foreground render can retry', async () => {
    const firstPageB = deferred();
    let pageBAttempts = 0;
    mocks.loadPageBuffer.mockImplementation((page) => {
      if (page.index === 0) return Promise.resolve(Buffer.from('A'));
      pageBAttempts += 1;
      return pageBAttempts === 1 ? firstPageB.promise : Promise.resolve(Buffer.from('B-retry'));
    });
    const { lastFrame, stdin, unmount } = renderReader();
    await waitFor(() => pageBAttempts === 1);

    firstPageB.reject(new Error('prefetch failed'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdin.write('l');
    await waitFor(() => lastFrame().includes('rendered-B-retry'));
    unmount();

    expect(pageBAttempts).toBe(2);
    expect(lastFrame()).toMatch(/\b2\/2\b/);
  });

  it('never keys old descriptors as the new chapter during a chapter change', async () => {
    const nextChapter = deferred();
    const oldPages = [{ id: 'old-0', index: 0 }, { id: 'old-1', index: 1 }];
    const newPages = [{ id: 'new-0', index: 0 }];
    mocks.getPages.mockImplementation((chapterId) => (
      chapterId === 'c1' ? Promise.resolve(oldPages) : nextChapter.promise
    ));
    mocks.loadPageBuffer.mockImplementation(async (descriptor) => Buffer.from(descriptor.id));

    const readerParams = {
      ...params,
      chapters: [
        { id: 'c1', number: '1', volume: '1' },
        { id: 'c2', number: '2', volume: '1' },
      ],
      startPage: 1,
    };
    const { lastFrame, stdin, unmount } = renderReader(readerParams);
    await waitFor(() => lastFrame().includes('rendered-old-1'));

    stdin.write('n');
    await waitFor(() => mocks.getPages.mock.calls.some(([id]) => id === 'c2'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.loadPageBuffer.mock.calls.some(([descriptor]) => descriptor.id === 'old-0')).toBe(false);

    nextChapter.resolve(newPages);
    await waitFor(() => lastFrame().includes('rendered-new-0'));
    unmount();

    expect(lastFrame()).toMatch(/Ch\. 2/);
    expect(lastFrame()).not.toContain('rendered-old-0');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { UIContext } from '../src/ui-context.js';

const mocks = vi.hoisted(() => ({
  entries: [],
  progress: null,
  chapters: [],
  getManga: vi.fn(),
  listAllChapters: vi.fn(),
}));

vi.mock('../src/state/store.js', () => ({
  getAllProgress: () => mocks.entries,
  getProgress: () => mocks.progress,
}));
vi.mock('../src/sources/index.js', () => ({
  getSource: () => ({ getManga: (...args) => mocks.getManga(...args) }),
  listAllChapters: (...args) => mocks.listAllChapters(...args),
}));

const { ContinueScreen, findResumeChapter } = await import('../src/components/screens/ContinueScreen.js');
const { MangaScreen } = await import('../src/components/screens/MangaScreen.js');

const manga = {
  source: 'test', id: 'm1', key: 'test:m1', title: 'Test Manga', authors: [], tags: [],
};
const entry = {
  source: 'test',
  mangaId: 'm1',
  mangaTitle: 'Test Manga',
  chapterId: 'old-id',
  chapterNumber: '12',
  chapterVolume: '3',
  page: 6,
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await sleep(5);
  }
  throw new Error('timed out waiting for condition');
}

beforeEach(() => {
  mocks.entries = [{ ...entry }];
  mocks.progress = { ...entry };
  mocks.chapters = [];
  mocks.getManga.mockReset().mockResolvedValue(manga);
  mocks.listAllChapters.mockReset().mockImplementation(async () => mocks.chapters);
});

describe('ContinueScreen recovery', () => {
  it('resumes an exact chapter id at the saved page', async () => {
    mocks.chapters = [{ id: 'old-id', number: '12', volume: '3' }];
    const openReader = vi.fn();
    const navigate = vi.fn();
    const { stdin, unmount } = render(
      <UIContext.Provider value={{ dimensions: { cols: 80, rows: 24 }, openReader, navigate }}>
        <ContinueScreen />
      </UIContext.Provider>,
    );

    await sleep(20);
    stdin.write('\r');
    await waitFor(() => openReader.mock.calls.length > 0);
    unmount();

    expect(openReader).toHaveBeenCalledWith(expect.objectContaining({
      chapters: mocks.chapters,
      chapterIndex: 0,
      startPage: 6,
    }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('accepts only a unique volume-and-number fallback after an id change', () => {
    const chapters = [
      { id: 'replacement', number: 12, volume: 3 },
      { id: 'other-volume', number: '12', volume: '4' },
    ];
    expect(findResumeChapter(chapters, entry)).toEqual({ index: 0, exact: false });
    expect(findResumeChapter(chapters, { ...entry, chapterVolume: null })).toBeNull();
  });

  it('does not treat positional local chapter numbers as a safe fallback', () => {
    expect(findResumeChapter(
      [{ id: '/library/manga#path:new', number: '12', volume: null }],
      { ...entry, source: 'local', chapterId: '/library/manga#12' },
    )).toBeNull();
  });

  it('starts a replacement chapter at page one instead of reusing its saved offset', async () => {
    mocks.chapters = [{ id: 'replacement', number: '12', volume: '3' }];
    const openReader = vi.fn();
    const { stdin, unmount } = render(
      <UIContext.Provider value={{
        dimensions: { cols: 80, rows: 24 }, openReader, navigate: vi.fn(),
      }}>
        <ContinueScreen />
      </UIContext.Provider>,
    );

    await sleep(20);
    stdin.write('\r');
    await waitFor(() => openReader.mock.calls.length > 0);
    unmount();

    expect(openReader).toHaveBeenCalledWith(expect.objectContaining({
      chapterIndex: 0,
      startPage: 0,
    }));
  });

  it('opens the chapter list with an actionable notice when no safe match exists', async () => {
    mocks.chapters = [{ id: 'different', number: '1', volume: '1' }];
    const openReader = vi.fn();
    const navigate = vi.fn();
    const { stdin, unmount } = render(
      <UIContext.Provider value={{ dimensions: { cols: 80, rows: 24 }, openReader, navigate }}>
        <ContinueScreen />
      </UIContext.Provider>,
    );

    await sleep(20);
    stdin.write('\r');
    await waitFor(() => navigate.mock.calls.length > 0);
    unmount();

    expect(openReader).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('manga', expect.objectContaining({
      sourceId: 'test',
      manga,
      resumeUnavailableFor: 'old-id',
      notice: expect.stringMatching(/saved chapter is no longer available/i),
    }));
  });

  it('shows the recovery notice and suppresses the stale resume shortcut', async () => {
    mocks.chapters = [{ id: 'different', number: '1', volume: '1' }];
    const { lastFrame, unmount } = render(
      <UIContext.Provider value={{
        dimensions: { cols: 80, rows: 24 },
        openReader: vi.fn(),
      }}>
        <MangaScreen params={{
          sourceId: 'test',
          manga,
          notice: 'Saved chapter unavailable. Choose another chapter.',
          resumeUnavailableFor: 'old-id',
        }} />
      </UIContext.Provider>,
    );
    await sleep(30);
    const frame = lastFrame();
    unmount();

    expect(frame).toContain('Saved chapter unavailable. Choose another chapter.');
    expect(frame).not.toContain('(press r)');
  });

  it('hides an unavailable saved chapter when manga is opened outside Continue', async () => {
    mocks.chapters = [{ id: 'different', number: '1', volume: '1' }];
    const { lastFrame, unmount } = render(
      <UIContext.Provider value={{
        dimensions: { cols: 80, rows: 24 },
        openReader: vi.fn(),
      }}>
        <MangaScreen params={{ sourceId: 'test', manga }} />
      </UIContext.Provider>,
    );
    await waitFor(() => lastFrame().includes('Chapters (1)'));
    const frame = lastFrame();
    unmount();

    expect(frame).not.toContain('(press r)');
    expect(frame).not.toContain('Resume Ch.12');
  });

  it('restores Resume and clears the stale notice after valid progress replaces it', async () => {
    mocks.progress = { ...entry, chapterId: 'new-valid-id', chapterNumber: '13', page: 2 };
    mocks.chapters = [{ id: 'new-valid-id', number: '13', volume: '3' }];
    const { lastFrame, unmount } = render(
      <UIContext.Provider value={{
        dimensions: { cols: 80, rows: 24 },
        openReader: vi.fn(),
      }}>
        <MangaScreen params={{
          sourceId: 'test',
          manga,
          notice: 'Saved chapter unavailable. Choose another chapter.',
          resumeUnavailableFor: 'old-id',
        }} />
      </UIContext.Provider>,
    );
    await waitFor(() => lastFrame().includes('(press r)'));
    const frame = lastFrame();
    unmount();

    expect(frame).toContain('Resume Ch.13 p.3');
    expect(frame).not.toContain('Saved chapter unavailable');
  });
});

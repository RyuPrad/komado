import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mdGet: vi.fn(),
  config: { language: 'en', contentRating: ['safe'] },
}));

vi.mock('../src/sources/mangadex/client.js', () => ({
  mdGet: (...args) => mocks.mdGet(...args),
  mdSend: vi.fn(),
}));
vi.mock('../src/sources/mangadex/auth.js', () => ({
  isLoggedIn: () => false, getSessionGeneration: () => 0,
}));
vi.mock('../src/state/store.js', () => ({ getConfig: () => mocks.config }));

const md = await import('../src/sources/mangadex/index.js');

const emptyFeed = () => ({ data: [], offset: 0, limit: 96, total: 0 });

beforeEach(() => {
  mocks.mdGet.mockReset().mockImplementation(async () => emptyFeed());
  mocks.config = { language: 'en', contentRating: ['safe'] };
});

describe('MangaDex chapter cache ratings', () => {
  it('fetches a fresh feed when the configured rating set changes', async () => {
    await md.listChapters('ratings-change');
    mocks.config = { language: 'en', contentRating: ['safe', 'erotica'] };
    await md.listChapters('ratings-change');

    expect(mocks.mdGet).toHaveBeenCalledTimes(2);
    expect(mocks.mdGet.mock.calls[0][1].contentRating).toEqual(['safe']);
    expect(mocks.mdGet.mock.calls[1][1].contentRating).toEqual(['erotica', 'safe']);
  });

  it('normalizes rating order and duplicates into one cache key', async () => {
    mocks.config = { language: 'en', contentRating: ['suggestive', 'safe', 'safe'] };
    await md.listChapters('ratings-normalized');
    mocks.config = { language: 'en', contentRating: ['safe', 'suggestive'] };
    await md.listChapters('ratings-normalized');

    expect(mocks.mdGet).toHaveBeenCalledTimes(1);
    expect(mocks.mdGet.mock.calls[0][1].contentRating).toEqual(['safe', 'suggestive']);
  });

  it('keeps an active source caller alive when the first screen cancels', async () => {
    let resolve;
    mocks.mdGet.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const ctrl = new AbortController();
    const oldScreen = md.listChapters('cancel-and-reopen', { signal: ctrl.signal });
    const currentScreen = md.listChapters('cancel-and-reopen');
    await vi.waitFor(() => expect(mocks.mdGet).toHaveBeenCalledTimes(1));
    ctrl.abort();
    await expect(oldScreen).rejects.toMatchObject({ name: 'AbortError' });
    resolve(emptyFeed());
    await expect(currentScreen).resolves.toMatchObject({ data: [] });
    await expect(md.listChapters('cancel-and-reopen')).resolves.toMatchObject({ data: [] });
    expect(mocks.mdGet).toHaveBeenCalledTimes(1);
  });
});

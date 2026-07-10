import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mdGet: vi.fn(),
  config: { language: 'en', contentRating: ['safe'] },
}));

vi.mock('../src/sources/mangadex/client.js', () => ({
  mdGet: (...args) => mocks.mdGet(...args),
  mdSend: vi.fn(),
}));
vi.mock('../src/sources/mangadex/auth.js', () => ({ isLoggedIn: () => false }));
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
});

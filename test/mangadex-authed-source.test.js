import { describe, it, expect, vi, beforeEach } from 'vitest';

// Isolate the source from the network + login/config state.
const mocks = vi.hoisted(() => ({
  mdGet: vi.fn(),
  mdSend: vi.fn(),
  loggedIn: true,
  config: { contentRating: ['safe', 'suggestive'], syncProgress: true },
}));
vi.mock('../src/sources/mangadex/client.js', () => ({
  mdGet: (...a) => mocks.mdGet(...a),
  mdSend: (...a) => mocks.mdSend(...a),
}));
vi.mock('../src/sources/mangadex/auth.js', () => ({ isLoggedIn: () => mocks.loggedIn }));
vi.mock('../src/state/store.js', () => ({ getConfig: () => mocks.config }));

const md = await import('../src/sources/mangadex/index.js');

const mangaEntry = (id, title) => ({
  id, type: 'manga',
  attributes: { title: { en: title }, status: 'ongoing', tags: [] },
  relationships: [],
});

beforeEach(() => {
  mocks.mdGet.mockReset();
  mocks.mdSend.mockReset();
  mocks.loggedIn = true;
  mocks.config = { contentRating: ['safe', 'suggestive'], syncProgress: true };
});

describe('mangadex authed source methods', () => {
  it('getFollows normalizes follows into the manga envelope', async () => {
    mocks.mdGet.mockResolvedValue({ data: [mangaEntry('m1', 'Followed One')], offset: 0, limit: 32, total: 1 });
    const res = await md.getFollows({ offset: 0, limit: 32 });

    expect(res.data[0]).toMatchObject({ source: 'mangadex', id: 'm1', title: 'Followed One' });
    const [path, params, opts] = mocks.mdGet.mock.calls[0];
    expect(path).toBe('/user/follows/manga');
    expect(opts).toMatchObject({ auth: true });
    expect(params.contentRating).toBeUndefined(); // endpoint 400s on contentRating[]
    expect(params.includes).toContain('cover_art');
  });

  it('getReadMarkers returns the chapter id list', async () => {
    mocks.mdGet.mockResolvedValue({ result: 'ok', data: ['c1', 'c2'] });
    expect(await md.getReadMarkers('m1')).toEqual(['c1', 'c2']);
    expect(mocks.mdGet.mock.calls[0][0]).toBe('/manga/m1/read');
    expect(mocks.mdGet.mock.calls[0][2]).toMatchObject({ auth: true });
  });

  it('markChaptersRead posts the read/unread body, and no-ops when empty', async () => {
    mocks.mdSend.mockResolvedValue({ result: 'ok' });
    await md.markChaptersRead('m1', ['c1']);
    expect(mocks.mdSend).toHaveBeenCalledWith(
      'POST', '/manga/m1/read', { chapterIdsRead: ['c1'], chapterIdsUnread: [] }, expect.anything(),
    );
    mocks.mdSend.mockClear();
    await md.markChaptersRead('m1', []);
    expect(mocks.mdSend).not.toHaveBeenCalled();
  });

  it('syncChapterRead pushes once then dedupes the same chapter', async () => {
    mocks.mdSend.mockResolvedValue({ result: 'ok' });
    await md.syncChapterRead('m1', 'dedupe-ch');
    await md.syncChapterRead('m1', 'dedupe-ch');
    expect(mocks.mdSend).toHaveBeenCalledTimes(1);
  });

  it('syncChapterRead respects the syncProgress setting and login state', async () => {
    mocks.config = { syncProgress: false };
    await md.syncChapterRead('m1', 'off-ch');
    expect(mocks.mdSend).not.toHaveBeenCalled();

    mocks.config = { syncProgress: true };
    mocks.loggedIn = false;
    await md.syncChapterRead('m1', 'anon-ch');
    expect(mocks.mdSend).not.toHaveBeenCalled();
  });
});

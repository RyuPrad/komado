import { describe, it, expect, vi, beforeEach } from 'vitest';

// Isolate the source from the network + login/config state (same pattern as
// mangadex-authed-source.test.js), plus the page-bytes fetch itself.
const mocks = vi.hoisted(() => ({
  mdGet: vi.fn(),
  fetch: vi.fn(),
  config: { contentRating: ['safe'], dataSaver: false, syncProgress: false },
}));
vi.mock('../src/sources/mangadex/client.js', () => ({
  mdGet: (...a) => mocks.mdGet(...a),
  mdSend: vi.fn(),
}));
vi.mock('../src/sources/mangadex/auth.js', () => ({
  isLoggedIn: () => false, getSessionGeneration: () => 0,
}));
vi.mock('../src/state/store.js', () => ({ getConfig: () => mocks.config }));
vi.mock('../src/lib/fetchWithBackoff.js', () => ({
  fetchWithBackoff: (...a) => mocks.fetch(...a),
  fetchJson: vi.fn(),
}));

const md = await import('../src/sources/mangadex/index.js');

const handout = (base) => ({
  baseUrl: base,
  chapter: { hash: 'h', data: ['p0.jpg', 'p1.jpg'], dataSaver: ['s0.jpg', 's1.jpg'] },
});
const deadResponse = (status) => ({ ok: false, status, body: { cancel: async () => {} } });
const okResponse = (byte) => ({ ok: true, arrayBuffer: async () => Uint8Array.from([byte]).buffer });

beforeEach(() => {
  mocks.mdGet.mockReset();
  mocks.fetch.mockReset();
});

describe('mangadex at-home token refresh', () => {
  it('getPages stamps descriptors with the chapter id for later rebuilds', async () => {
    mocks.mdGet.mockResolvedValueOnce(handout('https://node-a'));
    const pages = await md.getPages('ch-stamp');
    expect(pages[1]).toMatchObject({
      index: 1,
      chapterId: 'ch-stamp',
      url: 'https://node-a/data/h/p1.jpg',
    });
  });

  it('retries a dead page URL once with a fresh server handout', async () => {
    mocks.mdGet.mockResolvedValueOnce(handout('https://node-a'));
    const pages = await md.getPages('ch-retry');

    // The at-home token expired mid-chapter: old node 403s, fresh handout works.
    mocks.mdGet.mockResolvedValueOnce(handout('https://node-b'));
    mocks.fetch
      .mockResolvedValueOnce(deadResponse(403))
      .mockResolvedValueOnce(okResponse(7));

    const buf = await md.loadPageBuffer(pages[1]);
    expect(buf[0]).toBe(7);
    expect(mocks.fetch.mock.calls[0][0]).toBe('https://node-a/data/h/p1.jpg');
    expect(mocks.fetch.mock.calls[1][0]).toBe('https://node-b/data/h/p1.jpg');
    expect(mocks.mdGet).toHaveBeenCalledTimes(2); // initial + fresh (cache bypassed)
  });

  it('gives up with a typed error when the rebuilt URL also fails', async () => {
    mocks.mdGet.mockResolvedValue(handout('https://node-c'));
    const pages = await md.getPages('ch-dead');
    mocks.fetch.mockResolvedValue(deadResponse(410));

    await expect(md.loadPageBuffer(pages[0])).rejects.toMatchObject({
      name: 'NotFoundError',
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(2); // original + one retry, then stop
  });

  it('does not attempt a rebuild for descriptors without a chapter id', async () => {
    mocks.fetch.mockResolvedValue(deadResponse(403));
    await expect(md.loadPageBuffer({ index: 0, url: 'https://x/p.jpg' })).rejects.toThrow();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.mdGet).not.toHaveBeenCalled();
  });
});

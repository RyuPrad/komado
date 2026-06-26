import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithBackoff, fetchJson } from '../src/lib/fetchWithBackoff.js';

afterEach(() => vi.restoreAllMocks());

describe('fetchWithBackoff', () => {
  it('retries on 429 then returns the success response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithBackoff('https://x', { baseDelayMs: 1, retries: 3 });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns the last response after exhausting retries on 5xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithBackoff('https://x', { baseDelayMs: 1, retries: 2 });
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('does not retry once the caller aborts', async () => {
    const ctrl = new AbortController();
    const fetchMock = vi.fn(async (_url, { signal }) => {
      ctrl.abort();
      const err = new Error('aborted');
      err.name = 'AbortError';
      if (signal?.aborted) throw err;
      throw err;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWithBackoff('https://x', { signal: ctrl.signal, retries: 3 })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetchJson throws a typed SourceError on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
    await expect(fetchJson('https://x', { retries: 0 })).rejects.toMatchObject({
      name: 'SourceError',
      statusCode: 404,
    });
  });
});

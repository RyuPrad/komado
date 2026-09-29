import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  fetchWithBackoff: vi.fn(),
  getAccessToken: vi.fn(),
  isLoggedIn: vi.fn(),
  generation: 0,
}));

vi.mock('../src/lib/fetchWithBackoff.js', () => ({
  fetchJson: (...args) => mocks.fetchJson(...args),
  fetchWithBackoff: (...args) => mocks.fetchWithBackoff(...args),
}));
vi.mock('../src/sources/mangadex/auth.js', () => ({
  getAccessToken: (...args) => mocks.getAccessToken(...args),
  isLoggedIn: () => mocks.isLoggedIn(),
  getSessionGeneration: () => mocks.generation,
}));

const { mdGet, mdSend } = await import('../src/sources/mangadex/client.js');

const unauthorized = () => Object.assign(new Error('rejected token'), { statusCode: 401 });

beforeEach(() => {
  mocks.fetchJson.mockReset();
  mocks.fetchWithBackoff.mockReset();
  mocks.getAccessToken.mockReset();
  mocks.isLoggedIn.mockReset().mockReturnValue(true);
  mocks.generation = 0;
});

describe('MangaDex 401 recovery', () => {
  it('retries a public request with the forced-refresh token', async () => {
    const firstError = unauthorized();
    mocks.getAccessToken
      .mockResolvedValueOnce('stale-token')
      .mockResolvedValueOnce('fresh-token');
    mocks.fetchJson
      .mockRejectedValueOnce(firstError)
      .mockResolvedValueOnce({ result: 'ok' });

    await expect(mdGet('/manga', { title: 'test' })).resolves.toEqual({ result: 'ok' });

    expect(mocks.fetchJson).toHaveBeenCalledTimes(2);
    expect(mocks.fetchJson.mock.calls[0][1].headers.Authorization).toBe('Bearer stale-token');
    expect(mocks.fetchJson.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh-token');
    expect(mocks.getAccessToken).toHaveBeenNthCalledWith(2, { signal: undefined, force: true });
  });

  it('retries a public request anonymously when forced refresh fails', async () => {
    mocks.getAccessToken
      .mockResolvedValueOnce('stale-token')
      .mockRejectedValueOnce(new Error('token host unavailable'));
    mocks.fetchJson
      .mockRejectedValueOnce(unauthorized())
      .mockResolvedValueOnce({ result: 'anonymous-ok' });

    await expect(mdGet('/manga', null)).resolves.toEqual({ result: 'anonymous-ok' });

    expect(mocks.fetchJson).toHaveBeenCalledTimes(2);
    expect(mocks.fetchJson.mock.calls[1][1].headers).not.toHaveProperty('Authorization');
  });

  it('retries a public request anonymously when forced refresh returns no token', async () => {
    mocks.getAccessToken
      .mockResolvedValueOnce('stale-token')
      .mockResolvedValueOnce(null);
    mocks.fetchJson
      .mockRejectedValueOnce(unauthorized())
      .mockResolvedValueOnce({ result: 'anonymous-ok' });

    await expect(mdGet('/manga', null)).resolves.toEqual({ result: 'anonymous-ok' });

    expect(mocks.fetchJson).toHaveBeenCalledTimes(2);
    expect(mocks.fetchJson.mock.calls[1][1].headers).not.toHaveProperty('Authorization');
  });

  it('falls back anonymously when MangaDex also rejects the refreshed token', async () => {
    mocks.getAccessToken
      .mockResolvedValueOnce('stale-token')
      .mockResolvedValueOnce('fresh-but-rejected-token');
    mocks.fetchJson
      .mockRejectedValueOnce(unauthorized())
      .mockRejectedValueOnce(unauthorized())
      .mockResolvedValueOnce({ result: 'anonymous-ok' });

    await expect(mdGet('/manga', null)).resolves.toEqual({ result: 'anonymous-ok' });

    expect(mocks.fetchJson).toHaveBeenCalledTimes(3);
    expect(mocks.fetchJson.mock.calls[1][1].headers.Authorization)
      .toBe('Bearer fresh-but-rejected-token');
    expect(mocks.fetchJson.mock.calls[2][1].headers).not.toHaveProperty('Authorization');
  });

  it('does not refresh a public 401 when the request sent no Authorization header', async () => {
    const firstError = unauthorized();
    mocks.isLoggedIn.mockReturnValue(false);
    mocks.fetchJson.mockRejectedValueOnce(firstError);

    await expect(mdGet('/manga', null)).rejects.toBe(firstError);

    expect(mocks.fetchJson).toHaveBeenCalledTimes(1);
    expect(mocks.getAccessToken).not.toHaveBeenCalled();
  });

  it('keeps auth-required requests strict when forced refresh returns no token', async () => {
    const firstError = unauthorized();
    mocks.getAccessToken
      .mockResolvedValueOnce('stale-token')
      .mockResolvedValueOnce(null);
    mocks.fetchJson.mockRejectedValueOnce(firstError);

    await expect(mdGet('/user/follows/manga', null, { auth: true })).rejects.toBe(firstError);

    expect(mocks.fetchJson).toHaveBeenCalledTimes(1);
    expect(mocks.fetchJson.mock.calls[0][1].headers.Authorization).toBe('Bearer stale-token');
  });

  it('preserves the original strict-request 401 when forced refresh throws', async () => {
    const firstError = unauthorized();
    mocks.getAccessToken
      .mockResolvedValueOnce('stale-token')
      .mockRejectedValueOnce(new Error('refresh failed'));
    mocks.fetchJson.mockRejectedValueOnce(firstError);

    await expect(mdGet('/manga/m1/read', null, { auth: true })).rejects.toBe(firstError);
    expect(mocks.fetchJson).toHaveBeenCalledTimes(1);
  });

  it('applies the same anonymous fallback to explicitly public sends', async () => {
    mocks.getAccessToken
      .mockResolvedValueOnce('stale-token')
      .mockResolvedValueOnce(null);
    mocks.fetchWithBackoff
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: 'ok' }) });

    await expect(mdSend('POST', '/public-action', {}, { auth: false })).resolves.toEqual({ result: 'ok' });

    expect(mocks.fetchWithBackoff).toHaveBeenCalledTimes(2);
    expect(mocks.fetchWithBackoff.mock.calls[1][1].headers).not.toHaveProperty('Authorization');
  });

  it('does not retry an old account write with the new account token', async () => {
    mocks.getAccessToken.mockResolvedValue('A-token');
    mocks.fetchWithBackoff.mockImplementationOnce(async () => {
      mocks.generation += 1;
      return { ok: false, status: 401 };
    });
    await expect(mdSend('POST', '/manga/m1/read', {})).rejects.toMatchObject({ statusCode: 401 });
    expect(mocks.getAccessToken).toHaveBeenCalledTimes(1);
    expect(mocks.fetchWithBackoff).toHaveBeenCalledTimes(1);
  });

  it('rejects a read-marker push captured for a previous session before sending', async () => {
    mocks.generation = 1;
    await expect(mdSend('POST', '/manga/m1/read', {}, { session: 0 })).rejects.toThrow('account changed');
    expect(mocks.getAccessToken).not.toHaveBeenCalled();
    expect(mocks.fetchWithBackoff).not.toHaveBeenCalled();
  });
});

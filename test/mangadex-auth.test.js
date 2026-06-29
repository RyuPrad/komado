import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// In-memory credential store so auth.js never touches disk. vi.hoisted keeps the
// holder defined before the (hoisted) vi.mock factory runs.
const store = vi.hoisted(() => ({ creds: null }));
vi.mock('../src/state/store.js', () => ({
  getCredentials: () => (store.creds?.refreshToken ? store.creds : null),
  setCredentials: (next) => { store.creds = { ...next }; return store.creds; },
  clearCredentials: () => { store.creds = {}; },
}));

const { login, logout, getAccessToken, isLoggedIn } = await import('../src/sources/mangadex/auth.js');

const tokenResponse = (over = {}) => new Response(
  JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 900, ...over }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);
const creds = { clientId: 'c', clientSecret: 's', username: 'u', password: 'p' };

beforeEach(() => { store.creds = null; logout(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('mangadex auth', () => {
  it('login posts the password grant and caches the access token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse());
    vi.stubGlobal('fetch', fetchMock);

    await login(creds);
    expect(isLoggedIn()).toBe(true);
    const body = fetchMock.mock.calls[0][1].body;
    expect(body).toContain('grant_type=password');
    expect(body).toContain('client_id=c');
    expect(body).toContain('scope=offline_access'); // durable, restart-surviving session

    // A still-valid cached token must not trigger another request.
    expect(await getAccessToken()).toBe('AT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes with the stored refresh token once the access token is stale', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ expires_in: -100 })) // login → immediately stale
      .mockResolvedValueOnce(tokenResponse({ access_token: 'AT2', refresh_token: 'RT2' }));
    vi.stubGlobal('fetch', fetchMock);

    await login(creds);
    expect(await getAccessToken()).toBe('AT2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = fetchMock.mock.calls[1][1].body;
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=RT');
  });

  it('collapses concurrent refreshes into a single request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ expires_in: -100 }))
      .mockResolvedValue(tokenResponse({ access_token: 'AT2' }));
    vi.stubGlobal('fetch', fetchMock);

    await login(creds);
    const [a, b] = await Promise.all([getAccessToken(), getAccessToken()]);
    expect(a).toBe('AT2');
    expect(b).toBe('AT2');
    expect(fetchMock).toHaveBeenCalledTimes(2); // login + ONE refresh
  });

  it('clears the session when the refresh token is rejected', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ expires_in: -100 }))
      .mockResolvedValue(new Response('{"error":"invalid_grant"}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await login(creds);
    await expect(getAccessToken()).rejects.toThrow();
    expect(isLoggedIn()).toBe(false);
  });

  it('surfaces a typed AuthError on bad login credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"invalid_client"}', { status: 401 })));
    await expect(login(creds)).rejects.toMatchObject({ name: 'AuthError' });
    expect(isLoggedIn()).toBe(false);
  });

  it('falls back to a normal token when offline_access is not permitted', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"invalid_scope"}', { status: 400 }))
      .mockResolvedValueOnce(tokenResponse());
    vi.stubGlobal('fetch', fetchMock);

    await login(creds);
    expect(isLoggedIn()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2); // offline attempt + fallback
    expect(fetchMock.mock.calls[0][1].body).toContain('scope=offline_access');
    expect(fetchMock.mock.calls[1][1].body).not.toContain('scope=');
  });

  it('keeps the session when a refresh fails without invalid_grant', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ expires_in: -100 })) // login → stale
      .mockResolvedValue(new Response('{"error":"invalid_request"}', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await login(creds);
    await expect(getAccessToken()).rejects.toThrow();
    expect(isLoggedIn()).toBe(true); // NOT logged out — transient failure
  });
});

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
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

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
    expect(isLoggedIn()).toBe(true); // NOT logged out - transient failure
  });

  it('does not restore credentials when a refresh finishes after logout', async () => {
    const response = deferred();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ expires_in: -100 }))
      .mockImplementationOnce(() => response.promise);
    vi.stubGlobal('fetch', fetchMock);
    await login(creds);
    const oldRefresh = getAccessToken();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    logout();
    response.resolve(tokenResponse({ access_token: 'obsolete', refresh_token: 'obsolete-RT' }));
    expect(await oldRefresh).toBeNull();
    expect(isLoggedIn()).toBe(false);
    expect(await getAccessToken()).toBeNull();
  });

  it('does not let an old refresh failure log out a new account', async () => {
    const response = deferred();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ expires_in: -100 }))
      .mockImplementationOnce(() => response.promise)
      .mockResolvedValueOnce(tokenResponse({ access_token: 'B', refresh_token: 'B-RT' }));
    vi.stubGlobal('fetch', fetchMock);
    await login(creds);
    const oldRefresh = getAccessToken();
    const rejected = expect(oldRefresh).rejects.toMatchObject({ oauthError: 'invalid_grant' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await login({ ...creds, clientId: 'B-client' });
    response.resolve(new Response('{"error":"invalid_grant"}', { status: 401 }));
    await rejected;
    expect(isLoggedIn()).toBe(true);
    expect(await getAccessToken()).toBe('B');
    expect(store.creds).toMatchObject({ clientId: 'B-client', refreshToken: 'B-RT' });
  });

  it('keeps a new account refresh joinable when an obsolete refresh settles', async () => {
    const oldResponse = deferred();
    const newResponse = deferred();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ expires_in: -100 }))
      .mockImplementationOnce(() => oldResponse.promise)
      .mockResolvedValueOnce(tokenResponse({ access_token: 'B', expires_in: -100 }))
      .mockImplementationOnce(() => newResponse.promise);
    vi.stubGlobal('fetch', fetchMock);
    await login(creds);
    const oldRefresh = getAccessToken();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await login({ ...creds, clientId: 'B-client' });
    const newRefresh = getAccessToken();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    oldResponse.resolve(tokenResponse({ access_token: 'obsolete' }));
    expect(await oldRefresh).toBeNull();
    const joined = getAccessToken();
    newResponse.resolve(tokenResponse({ access_token: 'B2', refresh_token: 'B2-RT' }));
    expect(await Promise.all([newRefresh, joined])).toEqual(['B2', 'B2']);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(store.creds.refreshToken).toBe('B2-RT');
  });

  it('persists refresh rotation even when the first waiting screen cancels', async () => {
    const response = deferred();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse({ expires_in: -100 }))
      .mockImplementationOnce(() => response.promise);
    vi.stubGlobal('fetch', fetchMock);
    await login(creds);
    const ctrl = new AbortController();
    const cancelled = getAccessToken({ signal: ctrl.signal });
    const active = getAccessToken();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    ctrl.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(false);
    response.resolve(tokenResponse({ access_token: 'rotated', refresh_token: 'rotated-RT' }));
    expect(await active).toBe('rotated');
    expect(store.creds.refreshToken).toBe('rotated-RT');
  });

  it('does not save a successful but cancelled login response', async () => {
    const response = deferred();
    vi.stubGlobal('fetch', vi.fn(() => response.promise));
    const ctrl = new AbortController();
    const pending = login(creds, { signal: ctrl.signal });
    ctrl.abort();
    response.resolve(tokenResponse());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(isLoggedIn()).toBe(false);
  });

  it('does not save a superseded login over a newer login', async () => {
    const oldResponse = deferred();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => oldResponse.promise)
      .mockResolvedValueOnce(tokenResponse({ access_token: 'B', refresh_token: 'B-RT' }));
    vi.stubGlobal('fetch', fetchMock);
    const oldLogin = login(creds);
    await login({ ...creds, clientId: 'B-client' });
    oldResponse.resolve(tokenResponse());
    await expect(oldLogin).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.creds).toMatchObject({ clientId: 'B-client', refreshToken: 'B-RT' });
  });
});

import { fetchJson, fetchWithBackoff } from '../../lib/fetchWithBackoff.js';
import { MANGADEX } from '../../config.js';
import { AuthError, SourceError } from '../../lib/AppError.js';
import { getAccessToken, isLoggedIn, getSessionGeneration } from './auth.js';

const headers = {
  'User-Agent': MANGADEX.userAgent,
  Accept: 'application/json',
};

// MangaDex uses PHP-style array/object query params:
//   includes[]=cover_art   contentRating[]=safe   order[chapter]=asc
function qs(params) {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      value.forEach((item) => sp.append(`${key}[]`, item));
    } else if (typeof value === 'object') {
      for (const [ik, iv] of Object.entries(value)) sp.append(`${key}[${ik}]`, iv);
    } else {
      sp.append(key, value);
    }
  }
  return sp.toString();
}

// Resolve the Authorization header. `auth:true` endpoints REQUIRE a token (and
// error clearly without one); public endpoints attach it best-effort when the
// user is logged in, but never block browsing if the session can't refresh.
function sessionHeaders(h, { auth, session }) {
  if (session === getSessionGeneration()) return h;
  if (auth) throw new AuthError('MangaDex account changed. Please try again.');
  const anonymous = { ...h };
  delete anonymous.Authorization;
  return anonymous;
}

async function authHeader({ auth, signal, session }) {
  if (auth) {
    sessionHeaders({}, { auth, session });
    const token = await getAccessToken({ signal });
    if (!token) throw new AuthError('Log in to MangaDex to use this feature.');
    return sessionHeaders({ Authorization: `Bearer ${token}` }, { auth, session });
  }
  if (isLoggedIn()) {
    const token = await getAccessToken({ signal }).catch(() => null);
    if (token) return sessionHeaders({ Authorization: `Bearer ${token}` }, { auth, session });
  }
  return {};
}

// A public request may carry an optional account token. If MangaDex rejects it,
// try the rotated token once, then shed Authorization entirely so a dead login
// cannot take anonymous browsing down with it. Auth-required calls never shed
// the header and preserve the original 401 when refresh cannot recover.
async function retryUnauthorized(run, requestHeaders, originalError, { auth, signal, session }) {
  if (originalError.statusCode !== 401 || !requestHeaders.Authorization) throw originalError;

  let token = null;
  try {
    // Retrying an old account's write with a new account's token could mark an
    // unrelated user's chapter read. Public requests may still retry anonymously.
    if (session === getSessionGeneration()) token = await getAccessToken({ signal, force: true });
  } catch {
    if (auth) throw originalError;
  }

  if (token && session === getSessionGeneration()) {
    try {
      return await run({ ...requestHeaders, Authorization: `Bearer ${token}` });
    } catch (refreshedError) {
      if (auth || refreshedError.statusCode !== 401) throw refreshedError;
      // The refresh endpoint can succeed while the API still rejects that
      // account token. Public browsing remains valid, so shed it once rather
      // than letting a broken session take anonymous access down too.
    }
  }
  if (auth) throw originalError;

  const anonymousHeaders = { ...requestHeaders };
  delete anonymousHeaders.Authorization;
  return run(anonymousHeaders);
}

export async function mdGet(path, params, { signal, auth = false, session = getSessionGeneration() } = {}) {
  const url = `${MANGADEX.api}${path}${params ? `?${qs(params)}` : ''}`;
  const h = { ...headers, ...(await authHeader({ auth, signal, session })) };
  const request = (requestHeaders) => fetchJson(url, {
    headers: sessionHeaders(requestHeaders, { auth, session }), signal,
  });
  try {
    return await request(h);
  } catch (err) {
    return retryUnauthorized(request, h, err, { auth, signal, session });
  }
}

export async function mdSend(method, path, body, { signal, auth = true, session = getSessionGeneration() } = {}) {
  const url = `${MANGADEX.api}${path}`;
  const send = async (h) => {
    const res = await fetchWithBackoff(url, {
      method,
      headers: sessionHeaders(h, { auth, session }),
      body: body == null ? undefined : JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      throw new SourceError(`HTTP ${res.status} for ${url}`, { meta: { statusCode: res.status } });
    }
    return res.json().catch(() => ({}));
  };
  const base = { ...headers, 'Content-Type': 'application/json', ...(await authHeader({ auth, signal, session })) };
  try {
    return await send(base);
  } catch (err) {
    return retryUnauthorized(send, base, err, { auth, signal, session });
  }
}

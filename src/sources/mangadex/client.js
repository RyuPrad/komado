import { fetchJson, fetchWithBackoff } from '../../lib/fetchWithBackoff.js';
import { MANGADEX } from '../../config.js';
import { AuthError, SourceError } from '../../lib/AppError.js';
import { getAccessToken, isLoggedIn } from './auth.js';

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
async function authHeader({ auth, signal }) {
  if (auth) {
    const token = await getAccessToken({ signal });
    if (!token) throw new AuthError('Log in to MangaDex to use this feature.');
    return { Authorization: `Bearer ${token}` };
  }
  if (isLoggedIn()) {
    const token = await getAccessToken({ signal }).catch(() => null);
    if (token) return { Authorization: `Bearer ${token}` };
  }
  return {};
}

// A public request may carry an optional account token. If MangaDex rejects it,
// try the rotated token once, then shed Authorization entirely so a dead login
// cannot take anonymous browsing down with it. Auth-required calls never shed
// the header and preserve the original 401 when refresh cannot recover.
async function retryUnauthorized(run, requestHeaders, originalError, { auth, signal }) {
  if (originalError.statusCode !== 401 || !requestHeaders.Authorization) throw originalError;

  let token = null;
  try {
    token = await getAccessToken({ signal, force: true });
  } catch {
    if (auth) throw originalError;
  }

  if (token) {
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

export async function mdGet(path, params, { signal, auth = false } = {}) {
  const url = `${MANGADEX.api}${path}${params ? `?${qs(params)}` : ''}`;
  const h = { ...headers, ...(await authHeader({ auth, signal })) };
  const request = (requestHeaders) => fetchJson(url, { headers: requestHeaders, signal });
  try {
    return await request(h);
  } catch (err) {
    return retryUnauthorized(request, h, err, { auth, signal });
  }
}

export async function mdSend(method, path, body, { signal, auth = true } = {}) {
  const url = `${MANGADEX.api}${path}`;
  const send = async (h) => {
    const res = await fetchWithBackoff(url, {
      method,
      headers: h,
      body: body == null ? undefined : JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      throw new SourceError(`HTTP ${res.status} for ${url}`, { meta: { statusCode: res.status } });
    }
    return res.json().catch(() => ({}));
  };
  const base = { ...headers, 'Content-Type': 'application/json', ...(await authHeader({ auth, signal })) };
  try {
    return await send(base);
  } catch (err) {
    return retryUnauthorized(send, base, err, { auth, signal });
  }
}

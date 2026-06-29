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

export async function mdGet(path, params, { signal, auth = false } = {}) {
  const url = `${MANGADEX.api}${path}${params ? `?${qs(params)}` : ''}`;
  const h = { ...headers, ...(await authHeader({ auth, signal })) };
  try {
    return await fetchJson(url, { headers: h, signal });
  } catch (err) {
    // Token revoked server-side mid-session: force a refresh and retry once.
    if (auth && err.statusCode === 401 && isLoggedIn()) {
      const token = await getAccessToken({ signal, force: true });
      return fetchJson(url, { headers: { ...h, Authorization: `Bearer ${token}` }, signal });
    }
    throw err;
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
    if (auth && err.statusCode === 401 && isLoggedIn()) {
      const token = await getAccessToken({ signal, force: true });
      return send({ ...base, Authorization: `Bearer ${token}` });
    }
    throw err;
  }
}

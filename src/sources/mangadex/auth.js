import { fetchWithBackoff } from '../../lib/fetchWithBackoff.js';
import { MANGADEX } from '../../config.js';
import { AuthError } from '../../lib/AppError.js';
import { getCredentials, setCredentials, clearCredentials } from '../../state/store.js';
import { logger } from '../../lib/logger.js';

// MangaDex auth is OAuth2 "personal clients" (Keycloak). The user registers a
// client at mangadex.org/settings, then we exchange client id/secret + their
// username/password for a short-lived (15-min) access token and a rotating
// refresh token. Reading manga needs none of this — login only unlocks the
// user's follows/library and read-marker sync.

// The access token lives in memory only; the refresh token is the durable
// secret (persisted by the credential store).
let access = { token: null, expiresAt: 0 };
let refreshing = null; // shared in-flight refresh promise (stampede guard)

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const SKEW_MS = 30_000; // refresh this far ahead of the real expiry

export function isLoggedIn() {
  return !!getCredentials();
}

function postToken(params, signal) {
  return fetchWithBackoff(MANGADEX.auth, {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams(params).toString(),
    signal,
    retries: 1,
  });
}

async function tokenRequest(params, { signal } = {}) {
  // Ask for an OFFLINE refresh token so the session survives app restarts and
  // long idle gaps (it's refreshed on each use, ~30-day idle window) instead of
  // dying with the short-lived SSO session. If the client isn't allowed that
  // scope, transparently fall back to a normal token so login still works.
  let res = await postToken({ ...params, scope: 'offline_access' }, signal);
  if (res.status === 400) {
    const probe = await res.clone().json().catch(() => ({}));
    if (probe.error === 'invalid_scope') res = await postToken(params, signal);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json.error_description || json.error || `HTTP ${res.status}`;
    throw new AuthError(authMessage(res.status, detail), {
      meta: { statusCode: res.status, oauthError: json.error },
    });
  }
  return json;
}

function applyTokens(creds, json) {
  access = {
    token: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 900) * 1000,
  };
  // The refresh token rotates on each use — persist the latest one.
  setCredentials({ ...creds, refreshToken: json.refresh_token || creds.refreshToken });
}

export async function login({ clientId, clientSecret, username, password }, { signal } = {}) {
  const json = await tokenRequest({
    grant_type: 'password',
    username,
    password,
    client_id: clientId,
    client_secret: clientSecret,
  }, { signal });
  applyTokens({ clientId, clientSecret, refreshToken: json.refresh_token }, json);
  return true;
}

export function logout() {
  access = { token: null, expiresAt: 0 };
  refreshing = null;
  clearCredentials();
}

// Returns a currently-valid access token, refreshing if needed, or null when
// not logged in. `force` ignores the cached token (used after a 401).
export async function getAccessToken({ signal, force = false } = {}) {
  const creds = getCredentials();
  if (!creds) return null;
  if (!force && access.token && Date.now() < access.expiresAt - SKEW_MS) {
    return access.token;
  }
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const json = await tokenRequest({
          grant_type: 'refresh_token',
          refresh_token: creds.refreshToken,
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
        }, { signal });
        applyTokens(creds, json);
        return access.token;
      } catch (err) {
        // Only drop the saved session when the refresh token is DEFINITIVELY
        // dead (expired/revoked → invalid_grant). Transient or unexpected
        // failures keep the credentials so the next call — or next launch — can
        // recover, instead of silently logging the user out.
        if (err.oauthError === 'invalid_grant') {
          logger.warn('MangaDex refresh token expired/revoked — logging out', err);
          logout();
        }
        throw err;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

function authMessage(status, detail) {
  if (status === 401) return 'Login failed: check your username, password, and client credentials.';
  if (status === 400 && /client/i.test(detail)) {
    return 'Login failed: client not approved yet, or wrong client id / secret.';
  }
  return `Login failed (${status}): ${detail}`;
}

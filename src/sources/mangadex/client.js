import { fetchJson } from '../../lib/fetchWithBackoff.js';
import { MANGADEX } from '../../config.js';

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

export function mdGet(path, params, { signal } = {}) {
  const query = params ? `?${qs(params)}` : '';
  return fetchJson(`${MANGADEX.api}${path}${query}`, { headers, signal });
}

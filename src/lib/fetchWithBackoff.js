import { SourceError } from './AppError.js';

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    }, { once: true });
  });
}

// Global fetch + retries on 429/5xx with exponential backoff, honouring
// Retry-After, plus a hard per-attempt timeout. Caller-supplied AbortSignal
// short-circuits retries (used by the hooks' cancelled-flag guard).
export async function fetchWithBackoff(url, options = {}) {
  const {
    retries = 4,
    baseDelayMs = 500,
    maxDelayMs = 8_000,
    timeoutMs = 20_000,
    signal: extSignal,
    ...fetchOpts
  } = options;

  let attempt = 0;
  for (;;) {
    const ctrl = new AbortController();
    const onExtAbort = () => ctrl.abort(extSignal.reason);
    if (extSignal) {
      if (extSignal.aborted) ctrl.abort(extSignal.reason);
      else extSignal.addEventListener('abort', onExtAbort, { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);

    try {
      const res = await fetch(url, { ...fetchOpts, signal: ctrl.signal });

      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) + Math.random() * 200;
        attempt += 1;
        await sleep(delay, extSignal);
        continue;
      }
      return res;
    } catch (err) {
      // Caller cancelled — propagate without retrying.
      if (extSignal?.aborted) throw err;
      if (attempt < retries) {
        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) + Math.random() * 200;
        attempt += 1;
        await sleep(delay, extSignal);
        continue;
      }
      throw new SourceError(`Request failed: ${url}`, { cause: err });
    } finally {
      clearTimeout(timer);
      extSignal?.removeEventListener('abort', onExtAbort);
    }
  }
}

// Convenience JSON wrapper that throws a typed error on non-2xx.
export async function fetchJson(url, options = {}) {
  const res = await fetchWithBackoff(url, options);
  if (!res.ok) {
    throw new SourceError(`HTTP ${res.status} for ${url}`, { meta: { statusCode: res.status } });
  }
  return res.json();
}

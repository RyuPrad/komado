import { SourceError } from './AppError.js';

let requestSession = null;

// Screen cancellation only detaches shared work. The CLI owns the HTTP lifetime
// across Ink/viewer handoffs, and closes it once the whole app is leaving.
export function beginRequestSession() {
  requestSession = new AbortController();
  return requestSession;
}

export function endRequestSession(session) {
  session?.abort(new DOMException('Application closed', 'AbortError'));
}

function joinSignals(signals) {
  const active = signals.filter(Boolean);
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any(active), cleanup: () => {}, native: true };
  }
  // AbortSignal.any arrived in Node 20.3; retain support for earlier Node 20.
  const ctrl = new AbortController();
  const listeners = [];
  for (const signal of active) {
    if (signal.aborted) {
      ctrl.abort(signal.reason);
      break;
    }
    const onAbort = () => ctrl.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    listeners.push([signal, onAbort]);
  }
  const cleanup = () => {
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
  };
  return { signal: ctrl.signal, cleanup, native: false };
}

function keepBodySignal(response, cleanup) {
  if (!response.body?.getReader) {
    cleanup();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { cleanup(); controller.close(); }
        else controller.enqueue(value);
      } catch (err) {
        cleanup();
        controller.error(err);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { cleanup(); }
    },
  });
  const wrapped = new Response(body, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
  // Preserve fetch metadata when the Node 20.0–20.2 fallback wraps its body.
  for (const key of ['url', 'redirected', 'type']) {
    Object.defineProperty(wrapped, key, { value: response[key] });
  }
  return wrapped;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
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
  const sessionSignal = requestSession?.signal;
  const wait = async (delay) => {
    const joined = joinSignals([extSignal, sessionSignal]);
    try { await sleep(delay, joined.signal); } finally { joined.cleanup(); }
  };

  let attempt = 0;
  for (;;) {
    if (sessionSignal?.aborted) throw sessionSignal.reason;
    const ctrl = new AbortController();
    const joined = joinSignals([ctrl.signal, extSignal, sessionSignal]);
    let bodyOwnsCleanup = false;
    const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);

    try {
      const res = await fetch(url, { ...fetchOpts, signal: joined.signal });

      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) + Math.random() * 200;
        attempt += 1;
        // Release the abandoned response's connection instead of leaving it to GC.
        try { await res.body?.cancel(); } catch { /* already consumed - ignore */ }
        await wait(delay);
        continue;
      }
      if (!joined.native) {
        bodyOwnsCleanup = true;
        return keepBodySignal(res, joined.cleanup);
      }
      return res;
    } catch (err) {
      // Caller cancelled - propagate without retrying.
      if (extSignal?.aborted || sessionSignal?.aborted) throw err;
      if (attempt < retries) {
        const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) + Math.random() * 200;
        attempt += 1;
        await wait(delay);
        continue;
      }
      throw new SourceError(`Request failed: ${url}`, { cause: err });
    } finally {
      clearTimeout(timer);
      if (!bodyOwnsCleanup) joined.cleanup();
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

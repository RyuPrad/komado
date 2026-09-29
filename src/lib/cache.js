import { awaitWithSignal, throwIfAborted } from './abort.js';

// In-memory cache with TTL, negative caching, and stampede protection -
// a port of your createCache. `wrap` shares a single in-flight promise per key
// so concurrent callers (e.g. two screens requesting the same chapter) collapse
// into one upstream request.
export function createCache({ ttlMs = 60_000, negativeTtlMs = 5_000, max = 500 } = {}) {
  const store = new Map();      // key -> { value, expires }
  const inflight = new Map();   // key -> Promise

  function get(key) {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function set(key, value, ttl) {
    const isEmpty = value === null || value === undefined;
    const life = ttl ?? (isEmpty ? negativeTtlMs : ttlMs);
    store.set(key, { value, expires: Date.now() + life });
    // Cheap bound: evict the oldest insertion when over capacity.
    if (store.size > max) {
      const oldest = store.keys().next().value;
      store.delete(oldest);
    }
  }

  async function wrap(key, fn, ttl, { signal } = {}) {
    throwIfAborted(signal);
    const cached = get(key);
    if (cached !== undefined) return cached; // note: a cached `null` is a hit (negative cache)
    let promise = inflight.get(key);
    if (!promise) {
      // Register before calling the loader, including loaders that throw or
      // resolve synchronously. Screen signals cancel only their own wait.
      promise = Promise.resolve().then(fn).then((value) => {
        if (inflight.get(key) === promise) set(key, value, ttl);
        return value;
      }).finally(() => {
        if (inflight.get(key) === promise) inflight.delete(key);
      });
      inflight.set(key, promise);
    }
    return awaitWithSignal(promise, signal);
  }

  return {
    get,
    set,
    wrap,
    delete: (key) => store.delete(key),
    clear: () => { store.clear(); inflight.clear(); },
    get size() { return store.size; },
  };
}

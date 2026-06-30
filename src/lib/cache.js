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

  async function wrap(key, fn, ttl) {
    const cached = get(key);
    if (cached !== undefined) return cached; // note: a cached `null` is a hit (negative cache)
    if (inflight.has(key)) return inflight.get(key);

    const promise = (async () => {
      try {
        const value = await fn();
        set(key, value, ttl);
        return value;
      } finally {
        inflight.delete(key);
      }
    })();

    inflight.set(key, promise);
    return promise;
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

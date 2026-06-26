import { describe, it, expect, vi } from 'vitest';
import { createCache } from '../src/lib/cache.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('createCache', () => {
  it('returns a value within TTL and drops it after expiry', async () => {
    const c = createCache({ ttlMs: 40 });
    c.set('k', 1);
    expect(c.get('k')).toBe(1);
    await wait(60);
    expect(c.get('k')).toBeUndefined();
  });

  it('negative-caches null as a hit (distinct from absent)', () => {
    const c = createCache({ ttlMs: 1000, negativeTtlMs: 1000 });
    c.set('missing', null);
    expect(c.get('missing')).toBeNull();      // hit
    expect(c.get('never-set')).toBeUndefined(); // absent
  });

  it('wrap collapses concurrent calls (stampede protection)', async () => {
    const c = createCache({});
    const fn = vi.fn(async () => {
      await wait(20);
      return 42;
    });
    const [a, b] = await Promise.all([c.wrap('k', fn), c.wrap('k', fn)]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('wrap caches the resolved value for later calls', async () => {
    const c = createCache({});
    const fn = vi.fn(async () => 7);
    await c.wrap('k', fn);
    await c.wrap('k', fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

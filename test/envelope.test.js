import { describe, it, expect } from 'vitest';
import { envelope, paginate } from '../src/lib/envelope.js';

describe('envelope', () => {
  it('wraps data with pagination + meta', () => {
    expect(envelope([1, 2], { meta: { source: 'x' } })).toEqual({
      data: [1, 2],
      pagination: null,
      meta: { source: 'x' },
    });
  });

  it('paginate computes hasMore', () => {
    expect(paginate({ offset: 0, limit: 20, total: 50 }).hasMore).toBe(true);
    expect(paginate({ offset: 40, limit: 20, total: 50 }).hasMore).toBe(false);
    expect(paginate({ offset: 0, limit: 0, total: 0 }).hasMore).toBe(false);
  });
});

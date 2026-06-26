import { describe, it, expect } from 'vitest';
import { naturalSort, naturalCompare } from '../src/lib/natsort.js';

describe('natural sort', () => {
  it('orders embedded numbers numerically (2 before 10)', () => {
    expect(naturalSort(['page10', 'page2', 'page1'])).toEqual(['page1', 'page2', 'page10']);
  });

  it('handles decimal chapter numbers', () => {
    expect(naturalSort(['12', '12.5', '2', '1'])).toEqual(['1', '2', '12', '12.5']);
  });

  it('naturalCompare returns sign like a comparator', () => {
    expect(naturalCompare('a2', 'a10')).toBeLessThan(0);
    expect(naturalCompare('a10', 'a2')).toBeGreaterThan(0);
  });
});

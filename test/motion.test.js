import { describe, it, expect } from 'vitest';
import { easeToward } from '../src/lib/motion.js';

describe('easeToward', () => {
  it('moves toward the target without overshooting', () => {
    let p = 0;
    for (let i = 0; i < 100; i++) {
      const next = easeToward(p, 10, 16, 80, 0.15);
      expect(next).toBeGreaterThanOrEqual(p);
      expect(next).toBeLessThanOrEqual(10);
      p = next;
    }
    expect(p).toBe(10);
  });

  it('works in the negative direction', () => {
    let p = 10;
    for (let i = 0; i < 100; i++) p = easeToward(p, 2, 16, 80, 0.15);
    expect(p).toBe(2);
  });

  it('is frame-rate independent (two half-steps ≈ one full step)', () => {
    const one = easeToward(0, 100, 32, 80, 0);
    const two = easeToward(easeToward(0, 100, 16, 80, 0), 100, 16, 80, 0);
    expect(Math.abs(one - two)).toBeLessThan(1e-9);
  });

  it('a long stall (huge dt) lands on the target', () => {
    expect(easeToward(0, 100, 5000, 80, 0.15)).toBe(100);
  });

  it('dt=0 makes no move (a same-millisecond tick cannot stall the loop)', () => {
    expect(easeToward(5, 10, 0, 80, 0.1)).toBe(5);
  });

  it('snaps exactly onto the target when within range', () => {
    expect(easeToward(9.9, 10, 16, 80, 0.15)).toBe(10);
    expect(easeToward(10, 10, 16, 80, 0)).toBe(10); // already there
  });
});

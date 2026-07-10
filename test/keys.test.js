import { describe, it, expect, vi } from 'vitest';
import { createKeyTokenizer, tokenizeKeys } from '../src/lib/keys.js';

const ESC = '\x1b';

describe('tokenizeKeys', () => {
  it('passes single characters through', () => {
    expect(tokenizeKeys('j')).toEqual(['j']);
    expect(tokenizeKeys('\x03')).toEqual(['\x03']); // Ctrl+C survives
  });

  it('splits a batch of plain characters (fast key repeat)', () => {
    expect(tokenizeKeys('jjj')).toEqual(['j', 'j', 'j']);
  });

  it('keeps a single CSI sequence whole', () => {
    expect(tokenizeKeys(`${ESC}[B`)).toEqual([`${ESC}[B`]);
  });

  it('splits several CSI sequences batched into one chunk', () => {
    expect(tokenizeKeys(`${ESC}[B${ESC}[B${ESC}[A`)).toEqual([`${ESC}[B`, `${ESC}[B`, `${ESC}[A`]);
  });

  it('handles mixed characters and sequences in order', () => {
    expect(tokenizeKeys(`j${ESC}[Ak`)).toEqual(['j', `${ESC}[A`, 'k']);
  });

  it('consumes multi-byte CSI parameters up to the final byte', () => {
    expect(tokenizeKeys(`${ESC}[1;5C`)).toEqual([`${ESC}[1;5C`]);
  });

  it('treats a lone trailing ESC as a real Escape press', () => {
    expect(tokenizeKeys(ESC)).toEqual([ESC]);
    expect(tokenizeKeys(`j${ESC}`)).toEqual(['j', ESC]);
  });

  it('keeps SS3 (application-mode) arrow sequences whole', () => {
    expect(tokenizeKeys(`${ESC}OB${ESC}OA`)).toEqual([`${ESC}OB`, `${ESC}OA`]);
  });

  it('drops Alt+key pairs instead of misreading them as Escape', () => {
    expect(tokenizeKeys(`${ESC}x`)).toEqual([]);
    expect(tokenizeKeys(`${ESC}xj`)).toEqual(['j']);
  });

  it('emits an unterminated CSI fragment as-is (callers ignore it)', () => {
    expect(tokenizeKeys(`${ESC}[`)).toEqual([`${ESC}[`]);
  });

  it('keeps SGR mouse reports whole (wheel scrolling depends on it)', () => {
    expect(tokenizeKeys(`${ESC}[<65;40;12M`)).toEqual([`${ESC}[<65;40;12M`]);
    expect(tokenizeKeys(`${ESC}[<0;10;5m`)).toEqual([`${ESC}[<0;10;5m`]); // release
  });

  it('splits a fast wheel burst mixed with keys', () => {
    expect(tokenizeKeys(`${ESC}[<65;1;1M${ESC}[<65;1;1Mj${ESC}[B`))
      .toEqual([`${ESC}[<65;1;1M`, `${ESC}[<65;1;1M`, 'j', `${ESC}[B`]);
  });
});

describe('createKeyTokenizer', () => {
  it('joins CSI, SS3, and SGR mouse reports split across data events', () => {
    const seen = [];
    const decoder = createKeyTokenizer((tokens) => seen.push(...tokens));

    decoder.push(ESC);
    decoder.push('[');
    decoder.push('1;5');
    decoder.push('C');
    decoder.push(`${ESC}O`);
    decoder.push('A');
    decoder.push(`${ESC}[<65;40`);
    decoder.push(';12M');

    expect(seen).toEqual([`${ESC}[1;5C`, `${ESC}OA`, `${ESC}[<65;40;12M`]);
    decoder.close();
  });

  it('keeps ordering when fragments and batched keys are mixed', () => {
    const seen = [];
    const decoder = createKeyTokenizer((tokens) => seen.push(...tokens));

    decoder.push(`j${ESC}[`);
    decoder.push(`Bkk${ESC}`);
    decoder.push('[A');

    expect(seen).toEqual(['j', `${ESC}[B`, 'k', 'k', `${ESC}[A`]);
    decoder.close();
  });

  it('emits a standalone Escape only after the ambiguity timeout', () => {
    vi.useFakeTimers();
    try {
      const seen = [];
      const decoder = createKeyTokenizer((tokens) => seen.push(...tokens), { escapeDelay: 40 });
      decoder.push(ESC);

      vi.advanceTimersByTime(39);
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(seen).toEqual([ESC]);
      decoder.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the Escape timeout when the next event completes a sequence', () => {
    vi.useFakeTimers();
    try {
      const seen = [];
      const decoder = createKeyTokenizer((tokens) => seen.push(...tokens), { escapeDelay: 40 });
      decoder.push(ESC);
      vi.advanceTimersByTime(20);
      decoder.push('[B');
      vi.advanceTimersByTime(40);

      expect(seen).toEqual([`${ESC}[B`]);
      decoder.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

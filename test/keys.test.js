import { describe, it, expect } from 'vitest';
import { tokenizeKeys } from '../src/lib/keys.js';

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

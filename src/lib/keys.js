// Split a raw-mode stdin chunk into individual key tokens. Under fast
// key-repeat (or a paste) the terminal delivers several keypresses in ONE
// 'data' event - "\x1b[B\x1b[B\x1b[Bjj" - and a handler that compares the
// whole chunk against single sequences silently drops all of them. Tokens:
//   - a complete CSI sequence  "\x1b[...F"  (F = final byte @..~)
//   - an SS3 sequence          "\x1bOF"     (arrows in application-keys mode)
//   - a lone trailing ESC                   (a real Escape press)
//   - any single character
// An ESC glued to another byte that isn't [ or O (Alt+x etc.) is dropped
// rather than misread as an Escape press.
export function tokenizeKeys(chunk) {
  const s = String(chunk);
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c !== '\x1b') {
      out.push(c);
      i += 1;
      continue;
    }
    if (i === s.length - 1) {
      out.push('\x1b'); // nothing follows in this chunk - a bare Escape
      break;
    }
    const next = s[i + 1];
    if (next === '[') {
      let j = i + 2;
      while (j < s.length && !(s[j] >= '@' && s[j] <= '~')) j += 1;
      out.push(s.slice(i, Math.min(j + 1, s.length)));
      i = j + 1;
    } else if (next === 'O' && i + 2 < s.length) {
      out.push(s.slice(i, i + 3));
      i += 3;
    } else {
      i += 2; // Alt+<key> / unknown escape - skip both bytes
    }
  }
  return out;
}

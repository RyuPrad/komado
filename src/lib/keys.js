// Split raw-mode stdin into individual key tokens. Under fast key-repeat (or a
// paste) the terminal delivers several keypresses in ONE data event, while a
// PTY/SSH hop can split ONE escape sequence across several events. Tokens:
//   - a complete CSI sequence  "\x1b[...F"  (F = final byte @..~; this covers
//     SGR mouse reports "\x1b[<b;x;yM|m" too - '<', digits and ';' are all
//     parameter bytes, so a report stays one token)
//   - an SS3 sequence          "\x1bOF"     (arrows in application-keys mode)
//   - a lone ESC, after a short ambiguity delay (a real Escape press)
//   - any single character
// An ESC glued to another byte that isn't [ or O (Alt+x etc.) is dropped
// rather than misread as an Escape press.
function parseKeys(input, { final = false } = {}) {
  const s = String(input);
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
      if (final) out.push('\x1b');
      else return { tokens: out, rest: s.slice(i) };
      break;
    }
    const next = s[i + 1];
    if (next === '[') {
      let j = i + 2;
      while (j < s.length && !(s[j] >= '@' && s[j] <= '~')) j += 1;
      if (j === s.length && !final) return { tokens: out, rest: s.slice(i) };
      out.push(s.slice(i, Math.min(j + 1, s.length)));
      i = j + 1;
    } else if (next === 'O') {
      if (i + 2 >= s.length && !final) return { tokens: out, rest: s.slice(i) };
      if (i + 2 < s.length) {
        out.push(s.slice(i, i + 3));
        i += 3;
      } else {
        out.push(s.slice(i));
        break;
      }
    } else {
      i += 2; // Alt+<key> / unknown escape - skip both bytes
    }
  }
  return { tokens: out, rest: '' };
}

// Stateless compatibility helper for callers/tests that already have a whole
// chunk. Incomplete input is emitted exactly as supplied; live raw input should
// use createKeyTokenizer() so fragments can be joined across data events.
export function tokenizeKeys(chunk) {
  return parseKeys(chunk, { final: true }).tokens;
}

// Stateful raw-input decoder. A trailing CSI/SS3 fragment is retained until a
// later data event completes it. A bare ESC is ambiguous (Escape key vs the
// first byte of a sequence), so it is emitted only after a short delay. The
// callback is also used for synchronous tokens, keeping ordering identical
// whether the terminal batches or fragments its writes.
export function createKeyTokenizer(onTokens, { escapeDelay = 40 } = {}) {
  let rest = '';
  let escapeTimer = null;

  function clearEscapeTimer() {
    if (escapeTimer) clearTimeout(escapeTimer);
    escapeTimer = null;
  }

  function armEscapeTimer() {
    if (rest !== '\x1b') return;
    escapeTimer = setTimeout(() => {
      escapeTimer = null;
      if (rest !== '\x1b') return;
      rest = '';
      onTokens(['\x1b']);
    }, escapeDelay);
  }

  return {
    push(chunk) {
      clearEscapeTimer();
      const parsed = parseKeys(rest + String(chunk));
      rest = parsed.rest;
      if (parsed.tokens.length) onTokens(parsed.tokens);
      armEscapeTimer();
    },
    close() {
      clearEscapeTimer();
      rest = '';
    },
  };
}

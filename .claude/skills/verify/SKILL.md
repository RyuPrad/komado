---
name: verify
description: Drive komado end-to-end through a pseudo-terminal to verify reader/viewer changes at the real TUI surface.
---

# Verifying komado changes

komado needs a TTY and can't be seen headless, so verification = drive
`node dist/cli.js` through a Python pty and assert on the byte stream.
A working driver from a past session: the `kverify/` dir in that session's
scratchpad (driver.py + fixtures) - recreate from this recipe if gone.

## Recipe

1. `npm run build` (JSX-in-.js - `node src/cli.js` will not run).
2. Fixtures: scratch `KOMADO_HOME` with a `config.json` pointing
   `localLibraryPaths` at a generated library. For chapter-pagination paths
   make one manga dir with 600 `chNNN/` subdirs (1 tiny PNG each; give ch001
   three pages for reader nav). Generate the PNG with sharp from the repo's
   node_modules. Set `renderer: "halfblock"` for deterministic settle checks.
3. Spawn `node dist/cli.js` on a `pty.openpty()` pair, TIOCSWINSZ 100x30,
   `TERM=xterm-256color`, `start_new_session=True`, pump the master fd into a
   buffer from a thread.
   - Cell reader phase: `KOMADO_NO_PIXEL=1`.
   - Pixel viewer phase: `KOMADO_FORCE_PIXEL=1` (skips the probe; chafa must
     be installed). To emulate a sixel terminal instead, answer `ESC[16t`
     with `ESC[6;<H>;<W>t` and `ESC[c` with `ESC[?62;4c`.
4. Strip escapes for text asserts: remove DCS blobs first
   (`\x1bP.*?\x1b\\` DOTALL), then CSI/other escapes; decode UTF-8.

## Gotchas (cost real time)

- **Ink screens need humanly-spaced keys** (~150ms apart). A single write of
  `"\x1b[B\x1b[B\r"` gets ONE key processed by Ink. Batched chunks are only
  for testing the raw viewer's own tokenizer (`lib/keys.js`), which must
  handle them.
- **The reader header updates while status='loading'** - seeing `· 2/3` does
  NOT mean the page rendered. Wait for content glyphs (`▀` with the halfblock
  renderer) after a buffer mark before the next keypress, or progress never
  gets written and asserts on progress.json fail spuriously.
- Viewer asserts that work: count DCS frames (`\x1bP...\x1b\\`), check the
  raster header `"Pan;Pad;Ph;Pv` has Ph ≈ cols×cellW (default cellW 10), and
  match status-bar text (UTF-8, e.g. `· 1/3`).
- Quit paths: `q` anywhere; `\x03` (Ctrl+C) exits the viewer back to Ink and
  exits Ink entirely. Exit code must be 0; crashes land in
  `$KOMADO_HOME/komado.log` (set `KOMADO_DEBUG=1`).
- `$KOMADO_HOME/progress.json` is the durable-progress oracle (debounce
  400ms; a sync flush also runs on process exit).

## Flows worth driving

- Home → Local library → manga: assert `Chapters (600)` (pagination walker).
- Cell reader: l/l/l rolls into the next chapter only after renders settle.
- Pixel viewer: first DCS frame, batched `\x1b[B`*5 in one write still
  scrolls, `d` turns the page, Ctrl+C remounts Ink at the manga screen.
- MangaDex flows need the network; token-expiry recovery is unit-tested
  (test/mangadex-athome-retry.test.js), not driven live.

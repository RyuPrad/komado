# manga-tui

A terminal manga reader. Browse and read from **MangaDex** (online) or your **local
library** (CBZ/ZIP archives and image folders), rendered straight into the terminal
with [Ink](https://github.com/vadimdemedes/ink).

```
 manga-tui
 a terminal manga reader · MangaDex + local files

  › Search MangaDex      online catalog
    Popular on MangaDex   most followed
    Local library         your CBZ / folders
    Continue reading      resume
    Settings              config & library paths
    Quit
```

## Features

- **Two sources, one reader.** MangaDex and local files are normalized into a single
  shape, so search / details / reader / progress treat them identically.
- **Image rendering with graceful upgrade.** A pure-JS Unicode half-block renderer works
  in any 24-bit terminal; if [`chafa`](https://hpjansson.org/chafa/) is installed it’s
  auto-used for sharper output. Falls back automatically if anything goes wrong.
- **Reader UX.** Vertical scroll for tall pages, page/chapter navigation, fit-to-screen
  toggle, runtime renderer switching, and next-page prefetch.
- **Reading progress.** Where you left off is saved per manga and resumable from
  *Continue reading*.
- **Offline-friendly.** Point it at folders of `.cbz`/`.zip` or loose images.

## Requirements

- Node.js **≥ 20** (developed on Node 22).
- A 24-bit-color terminal (most modern ones).
- Optional but recommended: **`chafa`** for higher-fidelity rendering.
  - Debian/Ubuntu: `sudo apt install chafa` · macOS: `brew install chafa`

## Install & run

```bash
npm install
npm start            # or: node src/cli.js
```

Check what your terminal supports and where state is stored:

```bash
node src/cli.js doctor
```

Render a single image (path or URL) at the best fidelity your terminal allows — handy
for testing sixel/kitty terminals:

```bash
node src/cli.js render ./cover.jpg
node src/cli.js render https://example.com/page.png 100
```

## Keys

| Context | Keys | Action |
|---|---|---|
| Lists | `↑`/`↓` or `j`/`k`, `g`/`G`, `PgUp`/`PgDn` | move / jump / page |
| Lists | `enter` | open · `/` focus search · `esc` back |
| Reader | `↑`/`↓` or `j`/`k` | scroll within a page |
| Reader | `←`/`→` or `h`/`l`, `space` | previous / next page |
| Reader | `N` / `P` | next / previous chapter |
| Reader | `f` | toggle fit-to-screen |
| Reader | `r` | cycle renderer (`auto` → `halfblock` → `chafa`) |
| Global | `q` | quit · `esc` back |

## Local library layout

Add library folders in **Settings → Add library path…**. Within a library folder:

```
My Library/
  Berserk/                 # folder = a manga
    Chapter 1/             #   image subfolder = a chapter
      001.jpg 002.jpg …
    Chapter 2.cbz          #   …or a .cbz/.zip = a chapter
  One Shot.cbz             # a standalone .cbz = a single-chapter manga
```

Pages are ordered naturally (`2` before `10`). `.cbr`/`.rar` is detected but not yet
extracted (convert to `.cbz`).

## Where state lives

Everything is self-contained under `~/.manga-tui/` (override with `MANGA_TUI_HOME`):

- `config.json` — preferences + library paths
- `progress.json` — reading progress
- `cache/` — scratch space for the renderer

## Architecture

The layering mirrors a route→controller→service→db backend, adapted for a TUI:

```
cli.js → app.js (screen stack) → screens → hooks/state → sources/* → HTTP | filesystem
                                     └──────────────→ render/* (image → terminal)
```

- **`src/sources/*`** — each source (`mangadex`, `local`) implements the same interface
  (`search`, `getManga`, `listChapters`, `getPages`, `loadPageBuffer`) and returns the
  unified `{ data, pagination, meta }` envelope. The only source-specific seam is
  `loadPageBuffer`, which resolves raw bytes.
- **`src/domain/shape.js`** — the unified `Manga`/`Chapter` contract.
- **`src/render/*`** — capability detection + half-block (`sharp`) and `chafa` backends
  behind one `renderInline()` dispatcher, with half-block as the always-works fallback.
- **`src/lib/*`** — cross-cutting utilities ported from a server toolkit:
  `fetchWithBackoff` (retries 429/5xx + timeout), `createCache` (TTL + negative caching
  + stampede protection), `AppError`/typed errors, the response `envelope`.
- **`src/components/*` + `src/hooks/*`** — Ink UI. Effects use a cancelled-flag/abort
  guard against out-of-order responses, and reading progress writes are debounced.

### A note on `htm` vs JSX

UI is written with [`htm`](https://github.com/developit/htm) template literals instead of
JSX, so `node src/cli.js` runs with **no build step**. The syntax is close to JSX
(`html\`<${Box}>…<//>\``). Trade-off: because components are referenced inside template
literals, ESLint can’t statically see them “used,” so linting isn’t wired up here. If you
prefer JSX + ESLint, swap `htm` for an `esbuild`/`tsx` build — the component code ports
directly.

## Roadmap

- `.cbr`/`.rar` extraction (`node-unrar-js`)
- True sixel/kitty fullscreen page view (beyond the standalone `render` command)
- On-disk page cache for offline re-reads of MangaDex chapters
- Tests (Vitest + ink-testing-library) and CI

## Legal

Uses the public MangaDex API for personal reading. Respect MangaDex’s
[terms](https://api.mangadex.org/docs/) and rate limits, and support official releases
where available.

## License

MIT

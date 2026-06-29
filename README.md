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
- **Sign in to MangaDex (optional).** Log in to browse your **followed library**, see
  which chapters you've already read, and **sync progress back** — finishing a chapter
  marks it read on MangaDex. Reading itself needs no account.
- **Offline-friendly.** Point it at folders of `.cbz`/`.zip` or loose images.

## Requirements

- Node.js **≥ 20** (developed on Node 22).
- A 24-bit-color terminal (most modern ones).
- Optional but recommended: **`chafa`** for higher-fidelity rendering.
  - Debian/Ubuntu: `sudo apt install chafa` · macOS: `brew install chafa`

## Install & run

```bash
npm install     # also builds dist/ via the prepare script
npm start       # rebuilds, then launches the reader
```

The UI is JSX, transpiled to `dist/` by esbuild (`npm run build`). Check what your
terminal supports and where state is stored:

```bash
npm run doctor
```

Render a single image (path or URL) at the best fidelity your terminal allows — handy
for testing sixel/kitty terminals:

```bash
node dist/cli.js render ./cover.jpg
node dist/cli.js render https://example.com/page.png 100
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

## Rendering quality

Readable text needs real pixels. At startup the app probes your terminal (run
`npm run doctor` to see the result):

- **sixel or kitty graphics supported** → opening a chapter launches a
  full-resolution **pixel viewer** (chafa straight to the terminal). It renders
  full-width with vertical pan by default; press `f` to toggle whole-page fit.
  Keys: `n`/`p` page · `↑`/`↓` pan · `N`/`P` chapter · `f` fit · `q` back.
- **neither** → the in-Ink **cell reader** is used (Unicode half-blocks, or
  chafa symbols when available). Fine for art, coarse for small lettering —
  that's the hard ceiling of character-cell rendering.

Terminals with pixel support include kitty, WezTerm, Ghostty, foot, recent
Windows Terminal (≥ 1.22), and VS Code's terminal (with image support enabled).

## MangaDex account (optional)

Reading from MangaDex needs **no account**. Signing in only adds personalization:

- **My Library** — browse the manga you follow on MangaDex.
- **Read-markers** — chapters you've already read are marked in the chapter list.
- **Progress sync** — finishing a chapter pushes a read-marker back to MangaDex.

MangaDex uses OAuth2 **personal clients**, so logging in is a one-time setup:

1. On [mangadex.org](https://mangadex.org) → **Settings → API Clients**, create a
   personal client and note its **client ID** and **client secret**. (A new client may
   need staff approval before it works.)
2. In the app: **Settings → Log in to MangaDex…**, then enter the client id/secret plus
   your MangaDex username and password.

The session is **durable** — it requests an `offline_access` token and persists it, so
you stay logged in across restarts until you explicitly **log out** (Settings). Only the
client id/secret + refresh token are stored, in `~/.manga-tui/credentials.json` (mode
`600`); your password is never written to disk. Toggle write-back any time with
**Settings → Sync reading progress**.

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

Pages are ordered naturally (`2` before `10`). Both `.cbz`/`.zip` and `.cbr`/`.rar`
archives are supported (RAR via the WASM `node-unrar-js`, no system binary needed).

## Where state lives

Everything is self-contained under `~/.manga-tui/` (override with `MANGA_TUI_HOME`):

- `config.json` — preferences + library paths
- `progress.json` — reading progress
- `credentials.json` — MangaDex login (client id/secret + refresh token; mode `600`)
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

## Development

UI is plain JSX in `.js` files, transpiled to `dist/` by esbuild (a small
`scripts/build.mjs` does a transpile-only, structure-preserving build — no bundling,
so package imports stay external).

```bash
npm run build    # src/ → dist/  (esbuild, JSX automatic runtime)
npm run lint     # ESLint 9 (flat config, eslint-plugin-react + react-hooks)
npm test         # Vitest: lib/source unit tests + an ink-testing-library UI test
```

`npm test` covers the cache, backoff, envelope, natural sort, MangaDex normalization,
MangaDex auth (token refresh, offline-scope fallback, session handling) and the authed
source methods, the local source (folder + `.cbz` + `.cbr`), and an end-to-end UI walk
(home → local manga → reader) via ink-testing-library. The `.cbr` test is skipped
automatically where the `rar` binary isn't available.

## Roadmap

- True sixel/kitty fullscreen page view (beyond the standalone `render` command)
- On-disk page cache for offline re-reads of MangaDex chapters

## Legal

Uses the public MangaDex API for personal reading. Respect MangaDex’s
[terms](https://api.mangadex.org/docs/) and rate limits, and support official releases
where available.

## License

MIT

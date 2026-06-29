import { useState, useEffect, useRef, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { useUI } from '../../ui-context.js';
import { getSource } from '../../sources/index.js';
import { setProgress, getConfig } from '../../state/store.js';
import { chapterLabel } from '../../domain/shape.js';
import { renderInline, imageSize } from '../../render/image.js';
import { pickInlineBackend, RENDERER_CYCLE } from '../../render/detect.js';
import { Spinner, ErrorView, KeyHints } from '../ui.js';
import { truncate } from '../../lib/text.js';

export function ReaderScreen({ params }) {
  const { sourceId, manga, chapters, chapterIndex: startChapter, startPage = 0 } = params;
  const ui = useUI();
  const source = getSource(sourceId);
  const { cols, rows } = ui.dimensions;

  const [chapterIndex, setChapterIndex] = useState(startChapter);
  const [pages, setPages] = useState(null);
  const [pageIndex, setPageIndex] = useState(startPage);
  const [scroll, setScroll] = useState(0);
  const [rendered, setRendered] = useState(null);   // { lines, cols, rows }
  const [status, setStatus] = useState('loading');  // loading | ready | error
  const [error, setError] = useState(null);
  const [fitMode, setFitMode] = useState(false);
  const [rendererPref, setRendererPref] = useState(getConfig().renderer || 'auto');

  const chapter = chapters[chapterIndex];
  const viewportRows = Math.max(3, rows - 3); // status line + help line + margin
  const renderCache = useRef(new Map());
  const backend = useMemo(() => pickInlineBackend({ renderer: rendererPref }), [rendererPref]);

  // --- Load page descriptors when the chapter changes ---
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setStatus('loading');
    setPages(null);
    setError(null);
    (async () => {
      try {
        const pgs = await source.getPages(chapter.id, { signal: ctrl.signal });
        if (cancelled) return;
        setPages(pgs);
        setPageIndex((p) => Math.max(0, Math.min(p, pgs.length - 1)));
      } catch (err) {
        if (!cancelled) {
          setError(err);
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [chapter?.id]);

  const cacheKeyFor = (idx) =>
    `${chapter?.id}:${idx}:${cols}:${viewportRows}:${backend}:${fitMode ? 'fit' : 'scroll'}`;

  // Load + render one page into the cache, returning its lines.
  const renderPage = async (idx, signal) => {
    const key = cacheKeyFor(idx);
    if (renderCache.current.has(key)) return renderCache.current.get(key);
    const buf = await source.loadPageBuffer(pages[idx], { signal });
    let renderCols = cols;
    if (fitMode) {
      const { width, height } = await imageSize(buf);
      // Pick a width so the whole page fits within the viewport height.
      renderCols = Math.max(8, Math.min(cols, Math.floor(viewportRows * 2 * (width / height))));
    }
    const out = await renderInline(buf, { cols: renderCols, backend });
    renderCache.current.set(key, out);
    return out;
  };

  // Background prefetch (own controller — survives page turns, aborts on unmount).
  const prefetchers = useRef(new Set());
  useEffect(() => () => {
    for (const c of prefetchers.current) c.abort();
    prefetchers.current.clear();
  }, []);
  const prefetch = (idx) => {
    if (!pages?.[idx] || renderCache.current.has(cacheKeyFor(idx))) return;
    const c = new AbortController();
    prefetchers.current.add(c);
    renderPage(idx, c.signal).catch(() => {}).finally(() => prefetchers.current.delete(c));
  };

  // --- Render current page (no spinner flicker on cache hits) + prefetch next ---
  useEffect(() => {
    if (!pages || !pages[pageIndex]) return;
    let cancelled = false;
    const ctrl = new AbortController();

    if (renderCache.current.has(cacheKeyFor(pageIndex))) {
      setRendered(renderCache.current.get(cacheKeyFor(pageIndex)));
      setScroll(0);
      setStatus('ready');
    } else {
      setStatus('loading');
      renderPage(pageIndex, ctrl.signal)
        .then((out) => {
          if (cancelled) return;
          setRendered(out);
          setScroll(0);
          setStatus('ready');
        })
        .catch((err) => {
          if (!cancelled && !ctrl.signal.aborted) {
            setError(err);
            setStatus('error');
          }
        });
    }
    prefetch(pageIndex + 1);

    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [pages, pageIndex, cols, viewportRows, backend, fitMode]);

  // --- Persist reading progress on every settled page ---
  useEffect(() => {
    if (status !== 'ready' || !pages) return;
    setProgress(manga.key, {
      source: sourceId,
      mangaId: manga.id,
      mangaTitle: manga.title,
      chapterId: chapter.id,
      chapterNumber: chapter.number,
      page: pageIndex,
    });
    // Reaching the last page = finished the chapter → push a read-marker to
    // MangaDex. Self-guarded (login + setting) and deduped inside the source.
    if (pageIndex === pages.length - 1 && source.syncChapterRead) {
      source.syncChapterRead(manga.id, chapter.id);
    }
  }, [pageIndex, chapter?.id, status]);

  // --- Navigation helpers ---
  const lines = rendered?.lines || [];
  const maxScroll = Math.max(0, lines.length - viewportRows);

  const changeChapter = (delta) => {
    const next = chapterIndex + delta;
    if (next < 0 || next >= chapters.length) return;
    setChapterIndex(next);
    setPageIndex(0);
    setScroll(0);
  };
  const nextPage = () => {
    if (pages && pageIndex < pages.length - 1) {
      setPageIndex(pageIndex + 1);
      setScroll(0);
    } else {
      changeChapter(1);
    }
  };
  const prevPage = () => {
    if (pageIndex > 0) {
      setPageIndex(pageIndex - 1);
      setScroll(0);
    } else {
      changeChapter(-1);
    }
  };
  const cycleRenderer = () => {
    const i = RENDERER_CYCLE.indexOf(rendererPref);
    setRendererPref(RENDERER_CYCLE[(i + 1) % RENDERER_CYCLE.length]);
  };

  useInput((input, key) => {
    if (key.downArrow || input === 'j') setScroll((s) => Math.min(maxScroll, s + 1));
    else if (key.upArrow || input === 'k') setScroll((s) => Math.max(0, s - 1));
    else if (input === ' ' || key.pageDown) {
      if (scroll >= maxScroll) nextPage();
      else setScroll((s) => Math.min(maxScroll, s + viewportRows - 1));
    } else if (key.pageUp) setScroll((s) => Math.max(0, s - (viewportRows - 1)));
    else if (key.rightArrow || input === 'l' || input === 'n') nextPage();
    else if (key.leftArrow || input === 'h' || input === 'p') prevPage();
    else if (input === 'g') setScroll(0);
    else if (input === 'G') setScroll(maxScroll);
    else if (input === 'N') changeChapter(1);
    else if (input === 'P') changeChapter(-1);
    else if (input === 'f') setFitMode((f) => !f);
    else if (input === 'r') cycleRenderer();
  });

  // --- Render ---
  const pageLabel = pages ? `${pageIndex + 1}/${pages.length}` : '…';
  const slice = lines.slice(scroll, scroll + viewportRows);

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text color="magentaBright" bold>{truncate(manga.title, Math.max(10, cols - 34))}</Text>
        <Text>{`${truncate(chapterLabel(chapter), 24)} · ${pageLabel}${fitMode ? ' · fit' : ''}`}</Text>
      </Box>

      <Box height={viewportRows} flexDirection="column">
        {status === 'loading' ? (
          <Spinner label={pages ? `Rendering page ${pageIndex + 1}` : 'Loading chapter'} />
        ) : status === 'error' ? (
          <Box flexDirection="column">
            <ErrorView error={error} />
            <Text dimColor>Press N / P to skip to another chapter, or Esc to go back.</Text>
          </Box>
        ) : (
          slice.map((ln, i) => (
            <Text key={scroll + i} wrap="truncate-end">{ln}</Text>
          ))
        )}
      </Box>

      <KeyHints
        hints={[
          ['←→', 'page'],
          ['↑↓', 'scroll'],
          ['N/P', 'chapter'],
          ['f', fitMode ? 'scroll' : 'fit'],
          ['r', `render:${rendererPref}`],
          ['esc', 'back'],
        ]}
      />
    </Box>
  );
}

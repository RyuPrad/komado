import { useState, useLayoutEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { useUI } from '../../ui-context.js';
import { getSource, listAllChapters } from '../../sources/index.js';
import { getAllProgress } from '../../state/store.js';
import { makeManga } from '../../domain/shape.js';
import { List } from '../List.js';
import { Header, Spinner, KeyHints, ResizeHint } from '../ui.js';
import { truncateWidth, relativeTime, sanitizeTerminalText } from '../../lib/text.js';
import { getInkViewport } from '../../lib/layout.js';

function sameValue(a, b) {
  return a != null && a !== '' && b != null && b !== '' && String(a) === String(b);
}

// Chapter ids can change when a MangaDex upload is replaced or a local chapter
// is renamed. Only treat a unique number (+ volume, when it was saved) as the
// same logical chapter; an ambiguous match is not safe enough to auto-resume.
export function findResumeChapter(chapters, entry) {
  const exact = chapters.findIndex((chapter) => chapter.id === entry.chapterId);
  if (exact >= 0) return { index: exact, exact: true };
  // Local chapter numbers are display-order positions, not semantic chapter
  // numbers. Falling back by them after a path id disappears could select an
  // unrelated folder; require the user to choose explicitly instead.
  if (entry.source === 'local') return null;
  if (entry.chapterNumber == null || entry.chapterNumber === '') return null;

  const savedVolume = entry.chapterVolume ?? entry.volume;
  const matches = chapters
    .map((chapter, index) => ({ chapter, index }))
    .filter(({ chapter }) => (
      sameValue(chapter.number, entry.chapterNumber)
      && (savedVolume == null || savedVolume === '' || sameValue(chapter.volume, savedVolume))
    ));
  return matches.length === 1 ? { index: matches[0].index, exact: false } : null;
}

export function ContinueScreen() {
  const ui = useUI();
  const entries = getAllProgress();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const activeRequest = useRef(null);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const request = activeRequest.current;
      activeRequest.current = null;
      request?.ctrl.abort();
    };
  }, []);

  const open = async (entry) => {
    if (!mounted.current || activeRequest.current) return;
    const request = { ctrl: new AbortController() };
    activeRequest.current = request;
    setLoading(true);
    setError(null);
    try {
      const source = getSource(entry.source);
      const [manga, chapters] = await Promise.all([
        source
          .getManga(entry.mangaId, { signal: request.ctrl.signal })
          .catch(() => makeManga({ source: entry.source, id: entry.mangaId, title: entry.mangaTitle })),
        listAllChapters(source, entry.mangaId, { signal: request.ctrl.signal }),
      ]);
      // Local sources can ignore AbortSignal; ownership still prevents an
      // abandoned Continue action from opening a reader after the user went back.
      if (activeRequest.current !== request) return;
      const match = findResumeChapter(chapters, entry);
      if (!match) {
        ui.navigate('manga', {
          sourceId: entry.source,
          manga,
          notice: 'Your saved chapter is no longer available. Choose a chapter below to continue.',
          resumeUnavailableFor: entry.chapterId,
        });
        return;
      }
      ui.openReader({
        sourceId: entry.source,
        manga,
        chapters,
        chapterIndex: match.index,
        // A replacement upload can have a different page layout. Only an exact
        // chapter id is allowed to reuse the saved page offset.
        startPage: match.exact ? entry.page || 0 : 0,
      });
    } catch (err) {
      if (activeRequest.current === request) setError(err);
    } finally {
      if (activeRequest.current === request) {
        activeRequest.current = null;
        setLoading(false);
      }
    }
  };

  const { cols, rows } = getInkViewport(ui.dimensions);
  const compact = rows < 14;
  const showHeader = rows >= 4;
  const headerRows = showHeader ? compact ? 1 : 3 : 0;
  const footerRows = compact ? 1 : 2;
  const available = rows - headerRows - footerRows;
  const showError = !!error && available >= 2;
  const listBudget = Math.max(1, available - Number(showError));
  const showPosition = listBudget > 1 && entries.length > listBudget;

  if (rows < 3 || cols < 8) return <ResizeHint />;

  if (loading) {
    return (
      <Box flexDirection="column" width={cols}>
        {showHeader ? <Header title="Continue reading" compact={compact} /> : null}
        <Spinner label="Opening" />
        <KeyHints compact={compact} hints={[['esc', 'back']]} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={cols}>
      {showHeader ? <Header title="Continue reading" subtitle="pick up where you left off" compact={compact} /> : null}
      {showError ? <Text color="red" wrap="truncate-end">{sanitizeTerminalText(error.message || 'Opening failed')}</Text> : null}
      <List
        items={entries}
        height={listBudget - Number(showPosition)}
        showPosition={showPosition}
        onSelect={open}
        emptyText="No reading history yet."
        renderItem={(e, active) => (
          <Text key={`${e.source}:${e.mangaId}`} inverse={active} color={active ? 'cyanBright' : undefined} wrap="truncate-end">
            {truncateWidth(sanitizeTerminalText(` ${e.mangaTitle || e.mangaId} · ${e.chapterNumber != null ? `Ch.${e.chapterNumber}` : 'Oneshot'} p.${(e.page || 0) + 1}  ${relativeTime(e.updatedAt)}`), cols)}
          </Text>
        )}
      />
      <KeyHints compact={compact} hints={[['↑↓', 'move'], ['enter', 'resume'], ['esc', 'back']]} />
    </Box>
  );
}

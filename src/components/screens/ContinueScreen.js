import { useState } from 'react';
import { Box, Text } from 'ink';
import { useUI } from '../../ui-context.js';
import { getSource, listAllChapters } from '../../sources/index.js';
import { getAllProgress } from '../../state/store.js';
import { makeManga } from '../../domain/shape.js';
import { List } from '../List.js';
import { Header, Spinner, ErrorView, KeyHints } from '../ui.js';
import { truncate, relativeTime } from '../../lib/text.js';

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

  const open = async (entry) => {
    const source = getSource(entry.source);
    setLoading(true);
    setError(null);
    try {
      const [manga, chapters] = await Promise.all([
        source
          .getManga(entry.mangaId)
          .catch(() => makeManga({ source: entry.source, id: entry.mangaId, title: entry.mangaTitle })),
        listAllChapters(source, entry.mangaId),
      ]);
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
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <Box flexDirection="column">
        <Header title="Continue reading" />
        <Spinner label="Opening" />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header title="Continue reading" subtitle="pick up where you left off" />
      {error ? <ErrorView error={error} /> : null}
      <List
        items={entries}
        height={Math.max(5, (ui.dimensions.rows || 24) - 7)}
        onSelect={open}
        emptyText="No reading history yet."
        renderItem={(e, active) => (
          <Box key={`${e.source}:${e.mangaId}`} justifyContent="space-between">
            <Text inverse={active} color={active ? 'cyanBright' : undefined}>
              {` ${truncate(e.mangaTitle || e.mangaId, 40)} · ${e.chapterNumber != null ? `Ch.${e.chapterNumber}` : 'Oneshot'} p.${(e.page || 0) + 1} `}
            </Text>
            <Text dimColor>{relativeTime(e.updatedAt)}</Text>
          </Box>
        )}
      />
      <KeyHints hints={[['↑↓', 'move'], ['enter', 'resume'], ['esc', 'back']]} />
    </Box>
  );
}

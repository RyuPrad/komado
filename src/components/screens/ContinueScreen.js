import { useState } from 'react';
import { Box, Text } from 'ink';
import { useUI } from '../../ui-context.js';
import { getSource } from '../../sources/index.js';
import { getAllProgress } from '../../state/store.js';
import { makeManga } from '../../domain/shape.js';
import { List } from '../List.js';
import { Header, Spinner, ErrorView, KeyHints } from '../ui.js';
import { truncate, relativeTime } from '../../lib/text.js';

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
      const [manga, chRes] = await Promise.all([
        source
          .getManga(entry.mangaId)
          .catch(() => makeManga({ source: entry.source, id: entry.mangaId, title: entry.mangaTitle })),
        source.listChapters(entry.mangaId, { limit: 500 }),
      ]);
      const idx = chRes.data.findIndex((c) => c.id === entry.chapterId);
      ui.openReader({
        sourceId: entry.source,
        manga,
        chapters: chRes.data,
        chapterIndex: Math.max(0, idx),
        startPage: entry.page || 0,
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

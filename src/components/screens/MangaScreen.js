import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { useUI } from '../../ui-context.js';
import { getSource } from '../../sources/index.js';
import { getProgress } from '../../state/store.js';
import { chapterLabel } from '../../domain/shape.js';
import { List } from '../List.js';
import { Header, Spinner, ErrorView, KeyHints } from '../ui.js';
import { truncate } from '../../lib/text.js';

export function MangaScreen({ params }) {
  const { sourceId, manga: initial } = params;
  const ui = useUI();
  const source = getSource(sourceId);

  const [manga, setManga] = useState(initial);
  const [chapters, setChapters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const progress = getProgress(initial.key);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [full, chRes] = await Promise.all([
          source.getManga(initial.id, { signal: ctrl.signal }).catch(() => initial),
          source.listChapters(initial.id, { signal: ctrl.signal, limit: 500 }),
        ]);
        if (cancelled) return;
        setManga(full);
        setChapters(chRes.data);
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [initial.key]);

  const openAt = (index, startPage = 0) =>
    ui.navigate('reader', { sourceId, manga, chapters, chapterIndex: index, startPage });

  const resume = () => {
    if (!progress) return;
    const idx = chapters.findIndex((c) => c.id === progress.chapterId);
    if (idx >= 0) openAt(idx, progress.page || 0);
  };

  useInput((input) => {
    if (input === 'r' && progress && chapters.length) resume();
  });

  const cols = ui.dimensions.cols || 80;
  const resumeChapterId = progress?.chapterId;

  return (
    <Box flexDirection="column">
      <Header
        title={truncate(manga.title, cols - 4)}
        subtitle={[manga.authors?.join(', '), manga.status].filter(Boolean).join(' · ')}
      />
      {manga.tags?.length ? (
        <Text color="blue">{truncate(manga.tags.join(' · '), cols - 4)}</Text>
      ) : null}
      {manga.description ? (
        <Box marginTop={1} width={cols - 4}>
          <Text dimColor wrap="truncate-end">
            {truncate(manga.description.replace(/\s+/g, ' '), (cols - 4) * 3)}
          </Text>
        </Box>
      ) : null}
      {progress ? (
        <Box marginTop={1}>
          <Text color="green">{`▶ Resume Ch.${progress.chapterNumber ?? '?'} p.${(progress.page || 0) + 1}  (press r)`}</Text>
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Text bold>{`Chapters ${chapters.length ? `(${chapters.length})` : ''}`}</Text>
        {loading ? <Spinner label="Loading chapters" /> : null}
        {error ? <ErrorView error={error} /> : null}
        {!loading && !error ? (
          <List
            items={chapters}
            height={Math.max(4, (ui.dimensions.rows || 24) - 12)}
            onSelect={(_c, index) => openAt(index)}
            emptyText="No chapters available in this language (try changing language in Settings)."
            renderItem={(ch, active) => (
              <Box key={ch.id}>
                <Text
                  inverse={active}
                  color={active ? 'cyanBright' : ch.id === resumeChapterId ? 'green' : undefined}
                >
                  {` ${ch.id === resumeChapterId ? '▶ ' : '  '}${truncate(chapterLabel(ch), cols - 8)} `}
                </Text>
              </Box>
            )}
          />
        ) : null}
      </Box>
      <KeyHints hints={[['↑↓', 'move'], ['enter', 'read'], ...(progress ? [['r', 'resume']] : []), ['esc', 'back']]} />
    </Box>
  );
}

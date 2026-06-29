import { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { useUI } from '../../ui-context.js';
import { getSource } from '../../sources/index.js';
import { List } from '../List.js';
import { Header, Spinner, ErrorView, KeyHints } from '../ui.js';
import { truncate } from '../../lib/text.js';

const PAGE = 32;

// The signed-in user's MangaDex follows. Same browse/paginate shape as the
// search screen, minus the query box — getFollows is just another envelope.
export function LibraryScreen({ params }) {
  const sourceId = params?.sourceId || 'mangadex';
  const ui = useUI();
  const source = getSource(sourceId);

  const [results, setResults] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Monotonic request id guards against out-of-order responses.
  const reqId = useRef(0);
  const fetchPage = async (offset, append) => {
    const rid = ++reqId.current;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    try {
      const res = await source.getFollows({ offset, limit: PAGE, signal: ctrl.signal });
      if (rid !== reqId.current) return;
      setResults((prev) => (append ? [...prev, ...res.data] : res.data));
      setPagination(res.pagination);
    } catch (err) {
      if (rid === reqId.current) setError(err);
    } finally {
      if (rid === reqId.current) setLoading(false);
    }
  };

  useEffect(() => { fetchPage(0, false); }, []);

  const loadMore = () => {
    if (loading || !pagination?.hasMore) return;
    fetchPage(pagination.offset + pagination.limit, true);
  };
  const onHighlight = (_item, index) => {
    if (index >= results.length - 2) loadMore(); // prefetch near the end
  };

  const listHeight = Math.max(4, (ui.dimensions.rows || 24) - 8);

  return (
    <Box flexDirection="column">
      <Header title="My Library" subtitle="manga you follow on MangaDex" />
      {loading && !results.length ? <Spinner label="Loading your follows" /> : null}
      {error ? <ErrorView error={error} /> : null}
      {!error ? (
        <List
          items={results}
          height={listHeight}
          onSelect={(m) => ui.navigate('manga', { sourceId, manga: m })}
          onHighlight={onHighlight}
          emptyText={loading ? ' ' : 'You are not following any manga yet.'}
          renderItem={(m, active) => (
            <Box key={m.key}>
              <Text inverse={active} color={active ? 'cyanBright' : undefined}>
                {` ${truncate(m.title, Math.max(20, (ui.dimensions.cols || 80) - 24))} `}
              </Text>
              <Text dimColor>{`  ${m.status || ''}`}</Text>
            </Box>
          )}
        />
      ) : null}
      <KeyHints hints={[['↑↓', 'move'], ['enter', 'open'], ['esc', 'back']]} />
    </Box>
  );
}

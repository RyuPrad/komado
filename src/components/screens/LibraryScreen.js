import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { useUI } from '../../ui-context.js';
import { getSource } from '../../sources/index.js';
import { List } from '../List.js';
import { Header, Spinner, KeyHints, ResizeHint } from '../ui.js';
import { truncateWidth, sanitizeTerminalText } from '../../lib/text.js';
import { getInkViewport } from '../../lib/layout.js';

const PAGE = 32;

export function LibraryScreen({ params }) {
  const sourceId = params?.sourceId || 'mangadex';
  const ui = useUI();
  const source = getSource(sourceId);
  const [results, setResults] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [highlighted, setHighlighted] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const activeRequest = useRef(null);
  const failedRequest = useRef(null);
  const mounted = useRef(false);

  const fetchPage = useCallback(async (offset, append) => {
    if (!mounted.current || activeRequest.current) return;
    const request = { ctrl: new AbortController(), offset, append };
    activeRequest.current = request;
    failedRequest.current = null;
    setLoading(true);
    setError(null);
    try {
      const res = await source.getFollows({ offset, limit: PAGE, signal: request.ctrl.signal });
      if (activeRequest.current !== request) return;
      setResults((prev) => (append ? [...prev, ...res.data] : res.data));
      setPagination(res.pagination);
    } catch (err) {
      if (activeRequest.current !== request) return;
      failedRequest.current = { offset, append };
      setError(err);
    } finally {
      if (activeRequest.current === request) {
        activeRequest.current = null;
        setLoading(false);
      }
    }
  }, [source]);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const request = activeRequest.current;
      activeRequest.current = null;
      request?.ctrl.abort();
    };
  }, [source]);

  useEffect(() => {
    fetchPage(0, false);
  }, [fetchPage]);

  const hasMore = pagination?.hasMore;
  const nextOffset = (pagination?.offset || 0) + (pagination?.limit || PAGE);
  useEffect(() => {
    if (loading || error || !hasMore || !results.length
        || highlighted < results.length - 2 || activeRequest.current) return;
    fetchPage(nextOffset, true);
  }, [loading, error, hasMore, results.length, highlighted, nextOffset, fetchPage]);

  useInput((input) => {
    if (input === 'r' && error && !activeRequest.current) {
      const failed = failedRequest.current;
      if (failed) fetchPage(failed.offset, failed.append);
    }
  });

  const { cols, rows } = getInkViewport(ui.dimensions);
  const compact = rows < 14;
  const showHeader = rows >= 4;
  const headerRows = showHeader ? compact ? 1 : 3 : 0;
  const footerRows = compact ? 1 : 2;
  const available = rows - headerRows - footerRows;
  const showStatus = (loading || error) && available >= 2;
  const listBudget = Math.max(1, available - Number(showStatus));
  const showPosition = listBudget > 1 && results.length > listBudget;

  if (rows < 3 || cols < 8) return <ResizeHint />;

  return (
    <Box flexDirection="column" width={cols}>
      {showHeader ? <Header title="My Library" subtitle="manga you follow on MangaDex" compact={compact} /> : null}
      {showStatus ? error
        ? <Text color="red" wrap="truncate-end">{sanitizeTerminalText(`r retry · ${error.message || 'Loading failed'}`)}</Text>
        : <Spinner label={results.length ? 'Loading more follows' : 'Loading your follows'} />
        : null}
      <List items={results} height={listBudget - Number(showPosition)} showPosition={showPosition}
        onSelect={(m) => ui.navigate('manga', { sourceId, manga: m })}
        onHighlight={(_item, index) => setHighlighted(index)}
        emptyText={loading || error ? ' ' : 'You are not following any manga yet.'}
        renderItem={(m, active) => (
          <Text key={m.key} inverse={active} color={active ? 'cyanBright' : undefined} wrap="truncate-end">
            {truncateWidth(sanitizeTerminalText(` ${m.title}  ${m.status || ''}`), cols)}
          </Text>
        )} />
      <KeyHints compact={compact} hints={[...(error ? [['r', 'retry']] : []), ['↑↓', 'move'], ['enter', 'open'], ['esc', 'back']]} />
    </Box>
  );
}

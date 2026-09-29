import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useUI } from '../../ui-context.js';
import { getSource } from '../../sources/index.js';
import { List } from '../List.js';
import { Header, Spinner, KeyHints, ResizeHint } from '../ui.js';
import { truncateWidth, sanitizeTerminalText } from '../../lib/text.js';
import { getInkViewport } from '../../lib/layout.js';

const PAGE = 20;

export function SearchScreen({ params }) {
  const { sourceId, mode } = params;
  const ui = useUI();
  const source = getSource(sourceId);
  const { setTyping } = ui;
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState(mode === 'browse' ? '' : null);
  const [revision, setRevision] = useState(0);
  const [results, setResults] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [highlighted, setHighlighted] = useState(0);
  const [loading, setLoading] = useState(mode === 'browse');
  const [error, setError] = useState(null);
  const [focusInput, setFocusInput] = useState(mode !== 'browse');
  const activeRequest = useRef(null);
  const failedRequest = useRef(null);
  const mounted = useRef(false);

  useEffect(() => {
    setTyping(focusInput);
    return () => setTyping(false);
  }, [focusInput, setTyping]);

  const fetchPage = useCallback(async (q, offset, append) => {
    if (!mounted.current || (append && activeRequest.current)) return;
    const previous = activeRequest.current;
    const request = { ctrl: new AbortController(), q, offset, append };
    activeRequest.current = request;
    previous?.ctrl.abort();
    failedRequest.current = null;
    setLoading(true);
    setError(null);
    try {
      const res = await source.search(q, { offset, limit: PAGE, signal: request.ctrl.signal });
      if (activeRequest.current !== request) return;
      setResults((prev) => (append ? [...prev, ...res.data] : res.data));
      setPagination(res.pagination);
    } catch (err) {
      if (activeRequest.current !== request) return;
      failedRequest.current = { q, offset, append };
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
    if (mode === 'browse') fetchPage('', 0, false);
  }, [mode, fetchPage]);

  const onSubmit = () => {
    setSubmitted(query);
    setRevision((value) => value + 1);
    setResults([]);
    setPagination(null);
    setHighlighted(0);
    setFocusInput(false);
    fetchPage(query, 0, false);
  };

  const hasMore = pagination?.hasMore;
  const nextOffset = (pagination?.offset || 0) + (pagination?.limit || PAGE);
  useEffect(() => {
    // A highlight can arrive before loading settles. Recheck on completion too,
    // rather than relying on List's primitive-only notification effect to repeat.
    if (focusInput || loading || error || !hasMore || !results.length
        || highlighted < results.length - 2 || activeRequest.current) return;
    fetchPage(submitted ?? '', nextOffset, true);
  }, [focusInput, loading, error, hasMore, results.length, highlighted, submitted, nextOffset, fetchPage]);

  useInput((input, key) => {
    if (!focusInput && input === '/') setFocusInput(true);
    else if (focusInput && key.escape) setFocusInput(false);
    else if (!focusInput && input === 'r' && error && !activeRequest.current) {
      const failed = failedRequest.current;
      if (failed) fetchPage(failed.q, failed.offset, failed.append);
    }
  });

  const { cols, rows } = getInkViewport(ui.dimensions);
  const compact = rows < 14;
  const showHeader = rows >= 4;
  const showInput = focusInput || rows >= 4;
  const headerRows = showHeader ? compact ? 1 : 3 : 0;
  const footerRows = compact ? 1 : 2;
  const listMargin = compact ? 0 : 1;
  const available = rows - headerRows - Number(showInput) - footerRows - listMargin;
  const showStatus = (loading || error) && available >= 2;
  const listBudget = Math.max(1, available - Number(showStatus));
  const showPosition = listBudget > 1 && results.length > listBudget;
  const listHeight = listBudget - Number(showPosition);
  const hints = focusInput
    ? [['enter', 'search'], ['esc', 'to results']]
    : [...(error ? [['r', 'retry']] : []), ['↑↓', 'move'], ['enter', 'open'], ['/', 'search'], ['esc', 'back']];

  if (rows < 3 || cols < 8) return <ResizeHint />;

  return (
    <Box flexDirection="column" width={cols}>
      {showHeader ? (
        <Header title={source.label} compact={compact}
          subtitle={sourceId === 'local' ? 'filter your local library' : 'search the online catalog'} />
      ) : null}
      {showInput ? (
        <Box height={1}>
          <Text color={focusInput ? 'cyanBright' : 'gray'}>{focusInput ? '› ' : '  '}</Text>
          <Text wrap="truncate-end">
            <TextInput value={query} onChange={setQuery} onSubmit={onSubmit} focus={focusInput}
              placeholder={sourceId === 'local' ? 'type to filter…' : 'type a title, enter to search…'} />
          </Text>
        </Box>
      ) : null}
      {showStatus ? error
        ? <Text color="red" wrap="truncate-end">{sanitizeTerminalText(`r retry · ${error.message || 'Loading failed'}`)}</Text>
        : <Spinner label="Loading" />
        : null}
      {submitted !== null ? (
        <Box flexDirection="column" marginTop={listMargin}>
          <List key={revision} items={results} isActive={!focusInput} height={listHeight} showPosition={showPosition}
            onSelect={(m) => ui.navigate('manga', { sourceId, manga: m })}
            onHighlight={(_item, index) => setHighlighted(index)}
            emptyText={loading || error ? ' ' : submitted === '' ? 'Nothing found.' : `No results for "${sanitizeTerminalText(submitted)}".`}
            renderItem={(m, active) => (
              <Text key={m.key} inverse={active} color={active ? 'cyanBright' : undefined} wrap="truncate-end">
                {truncateWidth(sanitizeTerminalText(` ${m.title}  ${m.source === 'local' ? `${m.chaptersCount ?? '?'} ch` : m.status || ''}`), cols)}
              </Text>
            )} />
        </Box>
      ) : null}
      <KeyHints compact={compact} hints={hints} />
    </Box>
  );
}

import { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useUI } from '../../ui-context.js';
import { getSource } from '../../sources/index.js';
import { List } from '../List.js';
import { Header, Spinner, ErrorView, KeyHints } from '../ui.js';
import { truncate } from '../../lib/text.js';

const PAGE = 20;

export function SearchScreen({ params }) {
  const { sourceId, mode } = params;
  const ui = useUI();
  const source = getSource(sourceId);

  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState(mode === 'browse' ? '' : null); // null = not searched yet
  const [results, setResults] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(mode === 'browse');
  const [error, setError] = useState(null);
  const [focusInput, setFocusInput] = useState(mode !== 'browse');

  // Raise the typing flag while the input is focused so global keys don't fire.
  useEffect(() => {
    ui.setTyping(focusInput);
    return () => ui.setTyping(false);
  }, [focusInput]);

  // Monotonic request id guards against out-of-order responses (cancelled-flag).
  const reqId = useRef(0);
  const fetchPage = async (q, offset, append) => {
    const id = ++reqId.current;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    try {
      const res = await source.search(q, { offset, limit: PAGE, signal: ctrl.signal });
      if (id !== reqId.current) return; // a newer request superseded this one
      setResults((prev) => (append ? [...prev, ...res.data] : res.data));
      setPagination(res.pagination);
    } catch (err) {
      if (id === reqId.current) setError(err);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (mode === 'browse') fetchPage('', 0, false);
  }, []);

  const onSubmit = () => {
    setSubmitted(query);
    setFocusInput(false);
    fetchPage(query, 0, false);
  };

  const loadMore = () => {
    if (loading || !pagination?.hasMore) return;
    fetchPage(submitted ?? '', pagination.offset + pagination.limit, true);
  };

  const onHighlight = (_item, index) => {
    if (index >= results.length - 2) loadMore(); // prefetch near the end
  };

  // `/` refocuses the search box; Esc blurs it (handled here only while typing,
  // so it doesn't collide with the app-level Esc=back).
  useInput((input, key) => {
    if (!focusInput && input === '/') setFocusInput(true);
    else if (focusInput && key.escape) setFocusInput(false);
  });

  const listHeight = Math.max(4, (ui.dimensions.rows || 24) - 9);

  return (
    <Box flexDirection="column">
      <Header
        title={source.label}
        subtitle={sourceId === 'local' ? 'filter your local library' : 'search the online catalog'}
      />
      <Box>
        <Text color={focusInput ? 'cyanBright' : 'gray'}>{focusInput ? '› ' : '  '}</Text>
        <TextInput
          value={query}
          onChange={setQuery}
          onSubmit={onSubmit}
          focus={focusInput}
          placeholder={sourceId === 'local' ? 'type to filter…' : 'type a title, enter to search…'}
        />
      </Box>
      {loading ? <Box marginTop={1}><Spinner label="Loading" /></Box> : null}
      {error ? <Box marginTop={1}><ErrorView error={error} /></Box> : null}
      {!error && submitted !== null ? (
        <Box flexDirection="column" marginTop={1}>
          <List
            items={results}
            isActive={!focusInput}
            height={listHeight}
            onSelect={(m) => ui.navigate('manga', { sourceId, manga: m })}
            onHighlight={onHighlight}
            emptyText={loading ? ' ' : submitted === '' ? 'Nothing found.' : `No results for "${submitted}".`}
            renderItem={(m, active) => (
              <Box key={m.key}>
                <Text inverse={active} color={active ? 'cyanBright' : undefined}>
                  {` ${truncate(m.title, Math.max(20, (ui.dimensions.cols || 80) - 24))} `}
                </Text>
                <Text dimColor>{`  ${m.source === 'local' ? `${m.chaptersCount ?? '?'} ch` : m.status || ''}`}</Text>
              </Box>
            )}
          />
        </Box>
      ) : null}
      <KeyHints
        hints={focusInput
          ? [['enter', 'search'], ['esc', 'to results']]
          : [['↑↓', 'move'], ['enter', 'open'], ['/', 'search'], ['esc', 'back']]}
      />
    </Box>
  );
}

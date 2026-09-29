import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useUI } from '../../ui-context.js';
import { getConfig, setConfig } from '../../state/store.js';
import { scan } from '../../sources/local/index.js';
import { isLoggedIn, logout } from '../../sources/mangadex/auth.js';
import { detectCapabilities, RENDERER_CYCLE } from '../../render/detect.js';
import { List } from '../List.js';
import { Header, KeyHints, ResizeHint } from '../ui.js';
import { displayWidth, truncateWidth, sanitizeTerminalText } from '../../lib/text.js';
import { getInkViewport, isInkViewportUsable } from '../../lib/layout.js';
import { performUninstall, uninstallTargets, displayPath, formatUninstallSummary } from '../../uninstall.js';

const RATING_PRESETS = [
  ['safe'],
  ['safe', 'suggestive'],
  ['safe', 'suggestive', 'erotica'],
  ['safe', 'suggestive', 'erotica', 'pornographic'],
];
const ratingLabel = (arr) => arr.join('+');
const cycle = (list, current) => list[(list.indexOf(current) + 1) % list.length];

export function SettingsScreen() {
  const ui = useUI();
  const { cols, rows } = getInkViewport(ui.dimensions);
  const usable = isInkViewportUsable({ cols, rows });
  const compact = rows < 7;
  const showPosition = rows >= 4;
  const listHeight = Math.max(1, rows - (compact ? 2 : 5) - (showPosition ? 1 : 0));
  const caps = detectCapabilities();
  const [cfg, setCfg] = useState(getConfig());
  const [editing, setEditing] = useState(null); // null | 'language' | 'addPath'
  const [draft, setDraft] = useState('');
  const [highlighted, setHighlighted] = useState(null);
  const [, setTick] = useState(0); // force a re-render after login/logout

  const loggedIn = isLoggedIn();

  useEffect(() => {
    ui.setTyping(!!editing);
    return () => ui.setTyping(false);
  }, [editing]);

  const save = (patch) => setCfg({ ...setConfig(patch) });

  const items = [
    { id: 'account', kind: 'account', label: loggedIn ? 'MangaDex account' : 'Log in to MangaDex…',
      value: loggedIn ? 'logged in · enter to log out' : 'enter to log in' },
    ...(loggedIn ? [{ id: 'syncProgress', kind: 'toggle', label: 'Sync reading progress (MangaDex)', value: cfg.syncProgress ? 'on' : 'off' }] : []),
    { id: 'renderer', kind: 'cycle', label: 'Renderer', value: cfg.renderer + (caps.chafa ? '' : ' (chafa N/A)') },
    { id: 'dataSaver', kind: 'toggle', label: 'Data saver (smaller images)', value: cfg.dataSaver ? 'on' : 'off' },
    { id: 'rating', kind: 'cycle', label: 'Content rating', value: ratingLabel(cfg.contentRating) },
    { id: 'language', kind: 'edit', label: 'Language (MangaDex)', value: cfg.language },
    { id: 'addPath', kind: 'action', label: 'Add library path…', value: '' },
    ...cfg.localLibraryPaths.map((p, i) => ({
      id: `path:${i}`, kind: 'path', pathIndex: i, label: `Library: ${p}`, value: 'd to remove',
    })),
    { id: 'uninstall', kind: 'danger', label: 'Uninstall komado…', value: 'removes the app + all data' },
  ];

  const activate = (item) => {
    switch (item.kind) {
      case 'account':
        if (loggedIn) { logout(); return setTick((t) => t + 1); }
        return ui.navigate('login');
      case 'toggle':
        if (item.id === 'syncProgress') return save({ syncProgress: !cfg.syncProgress });
        return save({ dataSaver: !cfg.dataSaver });
      case 'cycle':
        if (item.id === 'renderer') return save({ renderer: cycle(RENDERER_CYCLE, cfg.renderer) });
        if (item.id === 'rating') {
          const idx = RATING_PRESETS.findIndex((p) => ratingLabel(p) === ratingLabel(cfg.contentRating));
          return save({ contentRating: RATING_PRESETS[(idx + 1) % RATING_PRESETS.length] });
        }
        return undefined;
      case 'edit':
        setDraft(cfg.language);
        return setEditing('language');
      case 'action':
        setDraft('');
        return setEditing('addPath');
      case 'danger':
        setDraft('');
        return setEditing('uninstall');
      default:
        return undefined;
    }
  };

  const submitEdit = () => {
    if (editing === 'uninstall') {
      // Only the exact word commits. performUninstall() disables persistence and
      // deletes everything; we register a goodbye to print AFTER Ink tears the
      // alt-screen down (cli.js's restore runs first), then quit.
      if (draft.trim().toLowerCase() === 'uninstall') {
        const results = performUninstall();
        process.once('exit', () => process.stdout.write(`\n${formatUninstallSummary(results)}\n`));
        ui.exit();
        return;
      }
      setEditing(null);
      setDraft('');
      return;
    }
    if (editing === 'language') {
      save({ language: draft.trim() || 'en' });
    } else if (editing === 'addPath' && draft.trim()) {
      save({ localLibraryPaths: [...cfg.localLibraryPaths, draft.trim()] });
      scan();
    }
    setEditing(null);
    setDraft('');
  };

  useInput((input, key) => {
    if (editing) {
      if (key.escape) {
        setEditing(null);
        setDraft('');
      }
      return;
    }
    if (!usable) return;
    if (input === 'd' && highlighted?.kind === 'path') {
      save({ localLibraryPaths: cfg.localLibraryPaths.filter((_, i) => i !== highlighted.pathIndex) });
      scan();
    }
  });

  if (!usable) return <ResizeHint />;

  return (
    <Box flexDirection="column">
      {editing && compact && rows === 3 ? null : <Header
        compact={compact}
        title="Settings"
        subtitle={`chafa: ${caps.chafa ? caps.chafaVersion : 'not installed'} · backend: ${caps.chafa ? 'chafa-symbols' : 'half-block'}`}
      />}

      {editing === 'uninstall' ? (
        <Box flexDirection="column">
          <Text color="redBright" bold>{'⚠  Uninstall komado'}</Text>
          <Text>This permanently deletes:</Text>
          {uninstallTargets().map((t) => (
            <Text key={t.path} color="red">
              {`  • ${displayPath(t.path)}`}
              <Text dimColor>{`  - ${t.label}`}</Text>
            </Text>
          ))}
          <Box marginTop={1}>
            <Text>{'Type '}</Text>
            <Text color="redBright" bold>uninstall</Text>
            <Text>{' to confirm: '}</Text>
            <TextInput value={draft} onChange={setDraft} onSubmit={submitEdit} focus={true} />
          </Box>
          <KeyHints compact={compact} hints={[['enter', 'confirm'], ['esc', 'cancel']]} />
        </Box>
      ) : editing ? (
        <Box flexDirection="column">
          <Text color="cyanBright" wrap="truncate-end">
            {editing === 'addPath' ? 'New library path (folder of manga / CBZ):' : 'Language code (e.g. en, fr, ja):'}
          </Text>
          <Box>
            <Text color="cyanBright">{'› '}</Text>
            <TextInput value={draft} onChange={setDraft} onSubmit={submitEdit} focus={true} />
          </Box>
          <KeyHints compact={compact} hints={[['enter', 'save'], ['esc', 'cancel']]} />
        </Box>
      ) : (
        <Box flexDirection="column">
          <List
            items={items}
            isActive={true}
            height={listHeight}
            showPosition={showPosition}
            onSelect={activate}
            onHighlight={(it) => setHighlighted(it)}
            renderItem={(it, active) => {
              const value = sanitizeTerminalText(it.value);
              const valueWidth = Math.min(displayWidth(value), Math.floor(cols / 2));
              const labelWidth = Math.max(1, cols - valueWidth - (value ? 1 : 0));
              return (
                <Box key={it.id} justifyContent="space-between">
                  <Text wrap="truncate-end" inverse={active} color={active ? 'cyanBright' : it.kind === 'danger' ? 'red' : it.kind === 'path' ? 'blue' : undefined}>
                    {truncateWidth(` ${sanitizeTerminalText(it.label)} `, labelWidth)}
                  </Text>
                  {value ? <Text dimColor wrap="truncate-end">{truncateWidth(value, valueWidth)}</Text> : null}
                </Box>
              );
            }}
          />
          <KeyHints compact={compact} hints={[['↑↓', 'move'], ['enter', 'change'], ['d', 'remove path'], ['esc', 'back']]} />
        </Box>
      )}
    </Box>
  );
}

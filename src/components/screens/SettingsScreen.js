import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useUI } from '../../ui-context.js';
import { getConfig, setConfig } from '../../state/store.js';
import { scan } from '../../sources/local/index.js';
import { isLoggedIn, logout } from '../../sources/mangadex/auth.js';
import { detectCapabilities } from '../../render/detect.js';
import { List } from '../List.js';
import { Header, KeyHints } from '../ui.js';
import { truncate } from '../../lib/text.js';

const RENDERERS = ['auto', 'halfblock', 'chafa'];
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
      id: `path:${i}`, kind: 'path', pathIndex: i, label: `Library: ${truncate(p, 48)}`, value: 'd to remove',
    })),
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
        if (item.id === 'renderer') return save({ renderer: cycle(RENDERERS, cfg.renderer) });
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
      default:
        return undefined;
    }
  };

  const submitEdit = () => {
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
    if (input === 'd' && highlighted?.kind === 'path') {
      save({ localLibraryPaths: cfg.localLibraryPaths.filter((_, i) => i !== highlighted.pathIndex) });
      scan();
    }
  });

  return (
    <Box flexDirection="column">
      <Header
        title="Settings"
        subtitle={`chafa: ${caps.chafa ? caps.chafaVersion : 'not installed'} · backend: ${caps.chafa ? 'chafa-symbols' : 'half-block'}`}
      />

      {editing ? (
        <Box flexDirection="column">
          <Text color="cyanBright">
            {editing === 'addPath' ? 'New library path (folder of manga / CBZ):' : 'Language code (e.g. en, fr, ja):'}
          </Text>
          <Box>
            <Text color="cyanBright">{'› '}</Text>
            <TextInput value={draft} onChange={setDraft} onSubmit={submitEdit} focus={true} />
          </Box>
          <KeyHints hints={[['enter', 'save'], ['esc', 'cancel']]} />
        </Box>
      ) : (
        <Box flexDirection="column">
          <List
            items={items}
            isActive={true}
            height={Math.max(6, (ui.dimensions.rows || 24) - 7)}
            onSelect={activate}
            onHighlight={(it) => setHighlighted(it)}
            renderItem={(it, active) => (
              <Box key={it.id} justifyContent="space-between">
                <Text inverse={active} color={active ? 'cyanBright' : it.kind === 'path' ? 'blue' : undefined}>
                  {` ${it.label} `}
                </Text>
                {it.value ? <Text dimColor>{it.value}</Text> : null}
              </Box>
            )}
          />
          <KeyHints hints={[['↑↓', 'move'], ['enter', 'change'], ['d', 'remove path'], ['esc', 'back']]} />
        </Box>
      )}
    </Box>
  );
}

import { Box, Text } from 'ink';
import { useUI } from '../../ui-context.js';
import { List } from '../List.js';
import { Header, KeyHints } from '../ui.js';
import { getAllProgress } from '../../state/store.js';
import { isLoggedIn } from '../../sources/mangadex/auth.js';

export function HomeScreen() {
  const ui = useUI();
  const hasProgress = getAllProgress().length > 0;

  const items = [
    { id: 'search', label: 'Search MangaDex', hint: 'online catalog' },
    { id: 'browse', label: 'Popular on MangaDex', hint: 'most followed' },
    ...(isLoggedIn() ? [{ id: 'library', label: 'My Library (MangaDex)', hint: 'your follows' }] : []),
    { id: 'local', label: 'Local library', hint: 'your CBZ / folders' },
    ...(hasProgress ? [{ id: 'continue', label: 'Continue reading', hint: 'resume' }] : []),
    { id: 'settings', label: 'Settings', hint: 'config & library paths' },
    { id: 'quit', label: 'Quit', hint: '' },
  ];

  const onSelect = (item) => {
    switch (item.id) {
      case 'search': return ui.navigate('search', { sourceId: 'mangadex', mode: 'search' });
      case 'browse': return ui.navigate('search', { sourceId: 'mangadex', mode: 'browse' });
      case 'library': return ui.navigate('library', { sourceId: 'mangadex' });
      case 'local': return ui.navigate('search', { sourceId: 'local', mode: 'browse' });
      case 'continue': return ui.navigate('continue');
      case 'settings': return ui.navigate('settings');
      case 'quit': return ui.exit();
      default: return undefined;
    }
  };

  return (
    <Box flexDirection="column">
      <Header title="manga-tui" subtitle="a terminal manga reader · MangaDex + local files" />
      <List
        items={items}
        height={items.length}
        onSelect={onSelect}
        renderItem={(item, active) => (
          <Box key={item.id}>
            <Text inverse={active} color={active ? 'cyanBright' : undefined}>
              {` ${active ? '›' : ' '} ${item.label} `}
            </Text>
            {item.hint ? <Text dimColor>{`  ${item.hint}`}</Text> : null}
          </Box>
        )}
      />
      <KeyHints hints={[['↑↓', 'move'], ['enter', 'select'], ['q', 'quit']]} />
    </Box>
  );
}

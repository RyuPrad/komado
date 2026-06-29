import { useState, useCallback } from 'react';
import { Box, useApp, useInput } from 'ink';
import { UIContext } from './ui-context.js';
import { useStdoutDimensions } from './hooks/useStdoutDimensions.js';
import { flushProgress } from './state/store.js';
import { HomeScreen } from './components/screens/HomeScreen.js';
import { SearchScreen } from './components/screens/SearchScreen.js';
import { MangaScreen } from './components/screens/MangaScreen.js';
import { ReaderScreen } from './components/screens/ReaderScreen.js';
import { SettingsScreen } from './components/screens/SettingsScreen.js';
import { ContinueScreen } from './components/screens/ContinueScreen.js';
import { LoginScreen } from './components/screens/LoginScreen.js';
import { LibraryScreen } from './components/screens/LibraryScreen.js';

const SCREENS = {
  home: HomeScreen,
  search: SearchScreen,
  manga: MangaScreen,
  reader: ReaderScreen,
  settings: SettingsScreen,
  continue: ContinueScreen,
  login: LoginScreen,
  library: LibraryScreen,
};

export function App({ caps = {}, onViewer, initialRoute = null }) {
  const { exit } = useApp();
  const dimensions = useStdoutDimensions();
  const [stack, setStack] = useState(
    initialRoute ? [{ name: 'home', params: {} }, initialRoute] : [{ name: 'home', params: {} }],
  );
  const [typing, setTyping] = useState(false);

  const navigate = useCallback((name, params = {}) => setStack((s) => [...s, { name, params }]), []);
  const goBack = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const replace = useCallback((name, params = {}) => setStack((s) => [...s.slice(0, -1), { name, params }]), []);
  const quit = useCallback(() => {
    flushProgress();
    exit();
  }, [exit]);

  // Global keys — suppressed while a text input is focused (`typing`).
  useInput((input, key) => {
    if (typing) return;
    if (input === 'q') quit();
    else if (key.escape) goBack();
  });

  const current = stack[stack.length - 1];
  const Screen = SCREENS[current.name] || HomeScreen;
  // openReader picks the high-res sixel/kitty viewer when the terminal supports
  // it (handled outside Ink), else the in-Ink cell reader.
  const openReader = useCallback(
    (payload) => {
      const pixel = onViewer && (caps.sixel || caps.kitty) && caps.chafa
        && !process.env.MANGA_TUI_NO_PIXEL; // escape hatch → force cell reader
      if (pixel) onViewer(payload);
      else navigate('reader', payload);
    },
    [onViewer, caps, navigate],
  );
  const ctx = { navigate, goBack, replace, exit: quit, setTyping, dimensions, caps, openReader };

  // Remount on each push/pop so screens start with fresh state. The key includes
  // the depth so navigating back rebuilds the previous screen.
  return (
    <UIContext.Provider value={ctx}>
      <Box flexDirection="column" paddingX={1}>
        <Screen key={`${stack.length}:${current.name}`} params={current.params} />
      </Box>
    </UIContext.Provider>
  );
}

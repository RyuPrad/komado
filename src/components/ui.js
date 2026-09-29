import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { sanitizeTerminalText } from '../lib/text.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Hand-rolled spinner - dependency-light, matching your preference for not
// pulling a package for something this small.
export function Spinner({ label = 'Loading' }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return <Text color="cyan" wrap="truncate-end">{`${FRAMES[frame]} ${sanitizeTerminalText(label)}…`}</Text>;
}

export function Header({ title, subtitle, compact = false }) {
  return (
    <Box flexDirection="column" marginBottom={compact ? 0 : 1}>
      <Text color="magentaBright" bold wrap="truncate-end">{sanitizeTerminalText(title)}</Text>
      {subtitle && !compact ? <Text dimColor wrap="truncate-end">{sanitizeTerminalText(subtitle)}</Text> : null}
    </Box>
  );
}

export function ErrorView({ error }) {
  return (
    <Box flexDirection="column">
      <Text color="red" bold wrap="truncate-end">{`✖ ${sanitizeTerminalText(error?.message || 'Something went wrong')}`}</Text>
      {error?.statusCode ? <Text dimColor>{`status ${error.statusCode}`}</Text> : null}
    </Box>
  );
}

// Footer key legend. `hints` is an array of [key, label] pairs.
export function KeyHints({ hints = [], compact = false }) {
  return (
    <Box marginTop={compact ? 0 : 1}>
      <Text dimColor wrap="truncate-end">{hints.map(([k, l]) => `${sanitizeTerminalText(k)} ${sanitizeTerminalText(l)}`).join('   ')}</Text>
    </Box>
  );
}

export function ResizeHint() {
  return <Text dimColor wrap="truncate-end">Resize terminal to continue. Esc goes back.</Text>;
}

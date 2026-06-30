import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Hand-rolled spinner - dependency-light, matching your preference for not
// pulling a package for something this small.
export function Spinner({ label = 'Loading' }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return <Text color="cyan">{`${FRAMES[frame]} ${label}…`}</Text>;
}

export function Header({ title, subtitle }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="magentaBright" bold>{title}</Text>
      {subtitle ? <Text dimColor>{subtitle}</Text> : null}
    </Box>
  );
}

export function ErrorView({ error }) {
  return (
    <Box flexDirection="column">
      <Text color="red" bold>{`✖ ${error?.message || 'Something went wrong'}`}</Text>
      {error?.statusCode ? <Text dimColor>{`status ${error.statusCode}`}</Text> : null}
    </Box>
  );
}

// Footer key legend. `hints` is an array of [key, label] pairs.
export function KeyHints({ hints = [] }) {
  return (
    <Box marginTop={1}>
      <Text dimColor>{hints.map(([k, l]) => `${k} ${l}`).join('   ')}</Text>
    </Box>
  );
}

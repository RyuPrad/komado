import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { html } from '../html.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Hand-rolled spinner — dependency-light, matching your preference for not
// pulling a package for something this small.
export function Spinner({ label = 'Loading' }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return html`<${Text} color="cyan">${FRAMES[frame]} ${label}…<//>`;
}

export function Header({ title, subtitle }) {
  return html`<${Box} flexDirection="column" marginBottom=${1}>
    <${Text} color="magentaBright" bold>${title}<//>
    ${subtitle ? html`<${Text} dimColor>${subtitle}<//>` : null}
  <//>`;
}

export function ErrorView({ error }) {
  return html`<${Box} flexDirection="column">
    <${Text} color="red" bold>✖ ${error?.message || 'Something went wrong'}<//>
    ${error?.statusCode ? html`<${Text} dimColor>status ${error.statusCode}<//>` : null}
  <//>`;
}

// Footer key legend. `hints` is an array of [key, label] pairs.
export function KeyHints({ hints = [] }) {
  return html`<${Box} marginTop=${1}>
    <${Text} dimColor>${hints.map(([k, l]) => `${k} ${l}`).join('   ')}<//>
  <//>`;
}

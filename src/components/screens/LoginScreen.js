import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useUI } from '../../ui-context.js';
import { login } from '../../sources/mangadex/auth.js';
import { Header, Spinner, ErrorView, KeyHints } from '../ui.js';

// MangaDex needs an OAuth2 "personal client" (client id/secret registered at
// mangadex.org/settings) plus the account's username/password. Secret and
// password fields are masked.
const FIELDS = [
  { key: 'clientId', label: 'Client ID', mask: false },
  { key: 'clientSecret', label: 'Client Secret', mask: true },
  { key: 'username', label: 'Username / email', mask: false },
  { key: 'password', label: 'Password', mask: true },
];

export function LoginScreen() {
  const ui = useUI();
  const [vals, setVals] = useState({ clientId: '', clientSecret: '', username: '', password: '' });
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // The whole screen is a form — keep global keys (q / Esc) suppressed.
  useEffect(() => {
    ui.setTyping(true);
    return () => ui.setTyping(false);
  }, []);

  const setField = (key) => (v) => setVals((s) => ({ ...s, [key]: v }));

  const submit = async () => {
    if (busy) return;
    if (idx < FIELDS.length - 1) { setIdx(idx + 1); return; }
    if (FIELDS.some((f) => !vals[f.key].trim())) {
      setError(new Error('All four fields are required.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login({
        clientId: vals.clientId.trim(),
        clientSecret: vals.clientSecret.trim(),
        username: vals.username.trim(),
        password: vals.password,
      });
      ui.goBack();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  useInput((input, key) => {
    if (busy) return;
    if (key.escape) ui.goBack();
    else if (key.tab || key.downArrow) setIdx((i) => (i + 1) % FIELDS.length);
    else if (key.upArrow) setIdx((i) => (i - 1 + FIELDS.length) % FIELDS.length);
  });

  return (
    <Box flexDirection="column">
      <Header title="Log in to MangaDex" subtitle="OAuth2 personal client" />
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>Create a personal client at mangadex.org/settings → API Clients,</Text>
        <Text dimColor>then enter its id + secret with your MangaDex login below.</Text>
        <Text dimColor>(A new client may need staff approval before it works.)</Text>
      </Box>
      {FIELDS.map((f, i) => (
        <Box key={f.key}>
          <Box width={16}>
            <Text color={i === idx ? 'cyanBright' : undefined}>{`${i === idx ? '› ' : '  '}${f.label}`}</Text>
          </Box>
          <Text dimColor>: </Text>
          <TextInput
            value={vals[f.key]}
            onChange={setField(f.key)}
            onSubmit={submit}
            focus={i === idx && !busy}
            mask={f.mask ? '*' : undefined}
            placeholder={i === idx ? 'type…' : ''}
          />
        </Box>
      ))}
      {busy ? <Box marginTop={1}><Spinner label="Signing in" /></Box> : null}
      {error ? <Box marginTop={1}><ErrorView error={error} /></Box> : null}
      <KeyHints hints={[['enter', 'next / submit'], ['tab ↑↓', 'fields'], ['esc', 'cancel']]} />
    </Box>
  );
}

// sharp loads a native binary built for one platform. Under WSL the Windows npm
// install's `komado` shim is on PATH too, and Linux Node fails on its Windows-only
// binary with a bare stack trace. Turn that failure into the actual fix.
// `file` is the running entry point; a /mnt/<drive>/ path under Linux means
// Windows files mounted into WSL.
export function explainSharpFailure(err, { file = '', platform = process.platform } = {}) {
  if (platform === 'linux' && /^\/mnt\/[a-z]\//i.test(file)) {
    return [
      `this komado was installed by Windows npm (${file}),`,
      "and Linux Node (WSL) can't load its Windows image library. To use komado",
      'inside WSL, install it there - it goes to ~/.local/bin, ahead of Windows paths:',
      '  curl -fsSL https://raw.githubusercontent.com/RyuPrad/komado/main/install.sh | bash',
    ].join('\n');
  }
  // sharp's own message continues with a long "Possible solutions" list.
  return `the image library (sharp) failed to load: ${String(err?.message ?? err).split('\n')[0]}\n`
    + 'Reinstall komado (with npm: npm i -g komado --include=optional).';
}

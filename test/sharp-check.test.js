import { describe, it, expect } from 'vitest';
import { explainSharpFailure } from '../src/lib/sharpCheck.js';

// The real failure starts like this and continues with a long list of fixes.
const loadError = new Error(
  'Could not load the "sharp" module using the linux-x64 runtime\nPossible solutions:\n- Ensure optional dependencies can be installed',
);
const windowsShim = '/mnt/c/Users/me/AppData/Roaming/npm/node_modules/komado/dist/cli.js';

describe('explainSharpFailure', () => {
  it('names the Windows-install-under-WSL mix-up and the WSL install command', () => {
    const msg = explainSharpFailure(loadError, { file: windowsShim, platform: 'linux' });
    expect(msg).toContain('installed by Windows npm');
    expect(msg).toContain(windowsShim);
    expect(msg).toContain('install.sh | bash');
  });

  it('falls back to a one-line reinstall hint elsewhere', () => {
    for (const ctx of [
      { file: '/usr/local/lib/node_modules/komado/dist/cli.js', platform: 'linux' },
      { file: windowsShim, platform: 'win32' }, // a /mnt path only means WSL under Linux
    ]) {
      const msg = explainSharpFailure(loadError, ctx);
      expect(msg).not.toContain('Windows npm');
      expect(msg).toContain('Could not load the "sharp" module using the linux-x64 runtime');
      expect(msg).not.toContain('Possible solutions');
      expect(msg).toContain('npm i -g komado --include=optional');
    }
  });
});

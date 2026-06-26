import os from 'node:os';
import path from 'node:path';
import { transform } from 'esbuild';
import { defineConfig } from 'vitest/config';

// Our source + tests are JSX-in-.js. Vite's SSR pipeline parses .js before any
// extension-based loader kicks in, so transform JSX away up front (enforce:'pre')
// with esbuild's automatic runtime. JS is a subset of the JSX loader, so plain
// modules pass through untouched.
const jsxInJs = {
  name: 'manga-tui:jsx-in-js',
  enforce: 'pre',
  async transform(code, id) {
    const file = id.split('?')[0];
    if (file.includes('/node_modules/') || !file.endsWith('.js')) return null;
    if (!/[/\\](src|test)[/\\]/.test(file)) return null;
    const result = await transform(code, {
      loader: 'jsx',
      jsx: 'automatic',
      jsxImportSource: 'react',
      sourcefile: file,
      sourcemap: true,
      target: 'node20',
      format: 'esm',
    });
    return { code: result.code, map: result.map };
  },
};

export default defineConfig({
  plugins: [jsxInJs],
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // Isolate runtime state from the real ~/.manga-tui.
    env: { MANGA_TUI_HOME: path.join(os.tmpdir(), 'manga-tui-vitest-home') },
  },
});

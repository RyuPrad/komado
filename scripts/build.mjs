import { build } from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

// Transpile-only build: every src/**/*.js (JSX included) → dist/, preserving the
// module layout and leaving package imports external. No bundling, so `node
// dist/cli.js` keeps the same lazy-import behaviour as the source.
function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const entryPoints = walk('src');
rmSync('dist', { recursive: true, force: true });

await build({
  entryPoints,
  outdir: 'dist',
  outbase: 'src',
  platform: 'node',
  format: 'esm',
  target: 'node20',
  jsx: 'automatic',      // React 17+ automatic runtime → no `import React` needed
  jsxImportSource: 'react',
  loader: { '.js': 'jsx' }, // our source is JSX-in-.js
  bundle: false,
  logLevel: 'warning',
});

console.log(`built ${entryPoints.length} files → dist/`);

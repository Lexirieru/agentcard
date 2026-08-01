import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // Runtime dependencies stay external rather than being vendored. The subpath
  // patterns matter: `viem/accounts` and `@modelcontextprotocol/server/stdio`
  // are separate specifiers that a bare package-name entry would not cover, and
  // bundling either would duplicate the package at runtime.
  // `bun:sqlite` / `node:sqlite` are runtime-provided modules the daemon picks
  // between at load time — the bundler must not try to resolve either.
  // `figlet` in particular MUST stay external: it loads its font files from
  // disk relative to its own module path, so a bundled copy renders no banner
  // at all (KTD-13).
  external: [
    'viem',
    /^viem\//,
    'hono',
    /^hono\//,
    'zod',
    /^zod\//,
    /^@modelcontextprotocol\//,
    '@clack/prompts',
    'figlet',
    'gradient-string',
    'boxen',
    'cli-table3',
    'bun:sqlite',
    'node:sqlite',
  ],
  // KTD-1: the bin entry must be directly executable after `npm i -g giwacard`.
  // tsdown lifts the `#!/usr/bin/env node` shebang out of `src/cli.ts` into
  // `dist/cli.js` and chmods the output executable, so no banner is needed —
  // adding one emits a second shebang line and breaks the ESM parse.
})

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
  // `viem` and `hono` stay external: runtime dependencies, not vendored.
  // `bun:sqlite` / `node:sqlite` are runtime-provided modules the daemon picks
  // between at load time — the bundler must not try to resolve either.
  external: ['viem', 'hono', /^hono\//, 'bun:sqlite', 'node:sqlite'],
  // KTD-1: the bin entry must be directly executable after `npm i -g giwacard`.
  // tsdown lifts the `#!/usr/bin/env node` shebang out of `src/cli.ts` into
  // `dist/cli.js` and chmods the output executable, so no banner is needed —
  // adding one emits a second shebang line and breaks the ESM parse.
})

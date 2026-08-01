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
  // `viem` stays external: it is a runtime dependency, not something we vendor.
  external: ['viem'],
  // KTD-1: the bin entry must be directly executable after `npm i -g giwacard`.
  // tsdown lifts the `#!/usr/bin/env node` shebang out of `src/cli.ts` into
  // `dist/cli.js` and chmods the output executable, so no banner is needed —
  // adding one emits a second shebang line and breaks the ESM parse.
})

import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  // Runtime dependencies, not vendored. `src/server.ts` additionally expects the
  // Bun runtime (it calls `Bun.serve`); the library entry (`src/index.ts`) is
  // runtime-agnostic and only needs a `fetch`-shaped host.
  external: ['viem', 'hono'],
})

import { createRequire } from 'node:module'

/**
 * Package version, read from `package.json` at runtime rather than inlined at
 * build time, so `dist/cli.js` and a locally linked checkout always report the
 * version that is actually installed.
 *
 * `../package.json` resolves correctly both from `dist/` (bundled output) and
 * from `src/` (tests, `bun run src/cli.ts`).
 */
const require = createRequire(import.meta.url)

function readVersion(): string {
  try {
    const pkg = require('../package.json') as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const VERSION: string = readVersion()

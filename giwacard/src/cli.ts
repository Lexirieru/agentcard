#!/usr/bin/env node
/**
 * Placeholder bin entry.
 *
 * The real interactive CLI (banner, onboarding wizard, `status`, `approve`,
 * `revoke`, `faucet`) is unit U7. Until then this only proves the bin wiring:
 * shebang, ESM, and a version that matches the installed package.
 */
import { GIWA_SEPOLIA_ID, giwaSepolia } from './chain/giwaSepolia.js'
import { keystoreExists, keystorePath } from './chain/keystore.js'
import { VERSION } from './version.js'

function main(argv: readonly string[]): number {
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  const lines = [
    `giwacard v${VERSION}`,
    `${giwaSepolia.name} (chain ${GIWA_SEPOLIA_ID})`,
    '',
    keystoreExists()
      ? `Keystore: ${keystorePath()}`
      : 'No keystore yet.',
    '',
    'Run `giwacard init` to set up your wallet, session key, and agent config.',
    '',
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

process.exitCode = main(process.argv.slice(2))

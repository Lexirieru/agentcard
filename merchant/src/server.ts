#!/usr/bin/env bun
/**
 * Standalone entrypoint for the GIWA Insights demo merchant.
 *
 * Runs on Bun (`bun src/server.ts`, or `bun dist/server.js` after a build).
 * The app itself is runtime-agnostic — `createMerchantApp` returns a Hono app
 * with a plain `fetch` handler — so this file is only the Bun-specific shell.
 *
 * Configuration comes from the environment; see `config.ts`. Note what is *not*
 * here: no private key, no mnemonic, no keystore. The merchant's facilitator
 * only reads the chain (KTD-9), so there is nothing for this process to sign
 * with and nothing to leak.
 */

import { MerchantConfigError } from './config.js'
import { createMerchantServiceFromEnv, INSIGHTS_PATH } from './index.js'

function main(): void {
  let service
  try {
    service = createMerchantServiceFromEnv(process.env)
  } catch (error) {
    if (error instanceof MerchantConfigError) {
      process.stderr.write(
        `giwa-merchant: configuration error (${error.setting})\n  ${error.message}\n\n` +
          'Required: MERCHANT_ADDRESS, CARD_VAULT_ADDRESS, GUSD_ADDRESS.\n' +
          'Optional: MERCHANT_PRICE_GUSD, MERCHANT_BASE_URL, MERCHANT_PORT, GIWA_RPC_URL,\n' +
          '          MERCHANT_INSIGHTS_BLOCKS, MERCHANT_INSIGHTS_CONCURRENCY,\n' +
          '          MERCHANT_PAYMENT_TIMEOUT_SECONDS.\n',
      )
      process.exit(1)
    }
    throw error
  }

  const { config, app } = service

  Bun.serve({
    port: config.port,
    fetch: app.fetch,
  })

  process.stdout.write(
    `GIWA Insights merchant listening on http://localhost:${config.port}\n` +
      `  paid resource   GET ${INSIGHTS_PATH}  (${config.priceDisplay} ${config.tokenSymbol})\n` +
      `  merchant        ${config.merchantAddress}\n` +
      `  vault           ${config.vaultAddress}\n` +
      `  asset           ${config.tokenAddress}\n` +
      `  chain           ${config.network} (${config.chainId}) via ${config.rpcUrl}\n` +
      '  release policy  sequencer-block — the report ships on sequencer inclusion, not on the\n' +
      '                  safe block. Accepted testnet reorg risk (KTD-5).\n',
  )
}

main()

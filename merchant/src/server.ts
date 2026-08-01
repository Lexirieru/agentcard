#!/usr/bin/env bun
/**
 * Standalone entrypoint for the GIWA Insights demo merchant.
 *
 * Runs on Bun (`bun src/server.ts`, or `bun dist/server.js` after a build).
 * The app itself is runtime-agnostic — `createMerchantApp` returns a Hono app
 * with a plain `fetch` handler — so this file is only the Bun-specific shell.
 *
 * Configuration comes from the environment; see `config.ts`. That now includes
 * `MERCHANT_PRIVATE_KEY`: since KTD-9 the merchant submits `CardVault.charge`
 * itself, so this process holds one secret and needs the account behind it
 * funded with GIWA Sepolia ETH. A missing or mismatched key is a startup error
 * here, not a 500 on the first paid request.
 */

import { MerchantConfigError, REQUIRED_ENV_VARS } from './config.js'
import { createMerchantServiceFromEnv, INSIGHTS_PATH } from './index.js'

function main(): void {
  let service
  try {
    service = createMerchantServiceFromEnv(process.env)
  } catch (error) {
    if (error instanceof MerchantConfigError) {
      process.stderr.write(
        `giwa-merchant: configuration error (${error.setting})\n  ${error.message}\n\n` +
          `Required: ${REQUIRED_ENV_VARS.join(', ')}.\n` +
          'Optional: MERCHANT_PRICE_GUSD, MERCHANT_BASE_URL, MERCHANT_PORT, GIWA_RPC_URL,\n' +
          '          MERCHANT_INSIGHTS_BLOCKS, MERCHANT_INSIGHTS_CONCURRENCY,\n' +
          '          MERCHANT_PAYMENT_TIMEOUT_SECONDS.\n\n' +
          'MERCHANT_PRIVATE_KEY must be the key of MERCHANT_ADDRESS, and that account must hold\n' +
          'GIWA Sepolia ETH: the merchant submits CardVault.charge itself (KTD-9). One charge\n' +
          'costs on the order of 1e-5 ETH, so one daily faucet claim covers hundreds of them.\n',
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
      `  merchant        ${config.merchantAddress}  (submits CardVault.charge; keep it funded)\n` +
      `  vault           ${config.vaultAddress}\n` +
      `  asset           ${config.tokenAddress}\n` +
      `  chain           ${config.network} (${config.chainId}) via ${config.rpcUrl}\n` +
      '  release policy  sequencer-block — the report ships on sequencer inclusion, not on the\n' +
      '                  safe block. Accepted testnet reorg risk (KTD-5).\n',
  )
}

main()

/**
 * The GiwaCard demo merchant: a paid API that answers HTTP 402 with payment
 * requirements, then serves its product once payment is verified onchain.
 *
 * The product is "GIWA Insights" (see `insights.ts`), priced at 1 gUSD per
 * request. The payment scheme is x402-shaped but settled by `CardVault.charge`
 * rather than Permit2 (see `x402.ts` for why). Verification is done by the
 * merchant's own facilitator, which is read-only and holds no key (`verify.ts`).
 *
 * This module is the library surface: `createMerchantApp` returns a Hono app you
 * can mount anywhere `fetch` exists. `src/server.ts` is the standalone binary.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Address } from 'viem'

import {
  createMerchantPublicClient,
  giwaSepolia,
  giwaSepoliaExplorer,
  type MerchantClientOptions,
  type MerchantPublicClient,
} from './chain.js'
import { loadMerchantConfig, type EnvBag, type MerchantConfig } from './config.js'
import {
  createViemInsightsReader,
  generateInsightsReport,
  type GiwaInsightsReport,
  type InsightsReader,
} from './insights.js'
import {
  createViemReceiptReader,
  MerchantFacilitator,
  type ChargeProof,
} from './verify.js'
import {
  buildPaymentRequiredBody,
  buildPaymentRequirements,
  decodePaymentHeader,
  encodeSettlementHeader,
  httpStatusForPaymentError,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PaymentError,
  RELEASE_POLICY,
  SETTLEMENT_CALL,
  X402_VERSION,
  type PaidResourceSpec,
  type PaymentRequirements,
  type SettlementResponse,
} from './x402.js'

export * from './chain.js'
export * from './config.js'
export * from './insights.js'
export * from './verify.js'
export * from './x402.js'

/** Path of the one paid resource this merchant sells. */
export const INSIGHTS_PATH = '/insights' as const

/** Catalogue entry for the paid resource. */
export const INSIGHTS_RESOURCE: PaidResourceSpec = {
  path: INSIGHTS_PATH,
  description:
    'GIWA Insights — an on-demand analytics report on GIWA Sepolia: sequencer block cadence, ' +
    'gas utilisation, base-fee movement and transaction activity over a recent block window, ' +
    'computed live from the chain.',
  mimeType: 'application/json',
}

/** Everything {@link createMerchantApp} needs, all injectable for tests. */
export interface MerchantAppOptions {
  /** Validated merchant configuration. */
  readonly config: MerchantConfig
  /** Read-only facilitator that judges payments. */
  readonly facilitator: MerchantFacilitator
  /** Chain reads backing the report. */
  readonly insightsReader: InsightsReader
  /** Injected clock, so tests are deterministic. */
  readonly now?: () => Date
}

/** Build the settlement receipt returned in `PAYMENT-RESPONSE`. */
function buildSettlement(
  config: MerchantConfig,
  proof: ChargeProof,
  settledAt: Date,
): SettlementResponse {
  return {
    success: true,
    x402Version: X402_VERSION,
    scheme: 'giwa-vault-charge',
    network: config.network,
    transaction: proof.transactionHash,
    payer: proof.vaultOwner,
    payee: proof.merchant,
    vault: proof.vault,
    cardId: proof.cardId.toString(),
    amount: proof.amount.toString(),
    released: proof.released.toString(),
    asset: config.tokenAddress,
    blockNumber: proof.blockNumber.toString(),
    blockHash: proof.blockHash,
    logIndex: proof.logIndex,
    releasePolicy: RELEASE_POLICY,
    settledAt: settledAt.toISOString(),
  }
}

/**
 * Create the merchant HTTP app.
 *
 * Free: `GET /`, `GET /health`, `GET /.well-known/x402`.
 * Paid: `GET /insights` — 1 gUSD, settled by `CardVault.charge`.
 */
export function createMerchantApp(options: MerchantAppOptions): Hono {
  const { config, facilitator, insightsReader } = options
  const now = options.now ?? (() => new Date())

  const requirements: PaymentRequirements = buildPaymentRequirements(
    config,
    INSIGHTS_RESOURCE,
  )

  const app = new Hono()

  /** 402 with the full requirements body. Always the same shape. */
  const refuse = (context: Context, error: PaymentError): Response => {
    const status = httpStatusForPaymentError(error.code)
    return context.json(
      buildPaymentRequiredBody(requirements, { code: error.code, message: error.message }),
      status,
    )
  }

  app.get('/', (context) =>
    context.json({
      service: 'GIWA Insights',
      description: INSIGHTS_RESOURCE.description,
      x402Version: X402_VERSION,
      scheme: requirements.scheme,
      network: config.network,
      chainId: config.chainId,
      price: `${config.priceDisplay} ${config.tokenSymbol}`,
      priceAtomic: requirements.maxAmountRequired,
      merchant: config.merchantAddress,
      vault: config.vaultAddress,
      asset: config.tokenAddress,
      paidResources: [requirements.resource],
      howToPay: [
        `GET ${requirements.resource} with no ${PAYMENT_HEADER} header to receive the 402 requirements.`,
        `Submit ${SETTLEMENT_CALL} from your session EOA, charging at least ${requirements.maxAmountRequired} base units to ${config.merchantAddress}.`,
        `Retry the request with ${PAYMENT_HEADER}: base64({"payload":{"transactionHash":"0x…","cardId":"<id>"}}).`,
        `On success the report is returned with a ${PAYMENT_RESPONSE_HEADER} settlement receipt.`,
      ],
      releasePolicy: requirements.extra.releasePolicy,
      releasePolicyNote: requirements.extra.releasePolicyNote,
      links: {
        merchant: giwaSepoliaExplorer.address(config.merchantAddress),
        vault: giwaSepoliaExplorer.address(config.vaultAddress),
        asset: giwaSepoliaExplorer.address(config.tokenAddress),
      },
    }),
  )

  app.get('/health', (context) =>
    context.json({
      status: 'ok',
      time: now().toISOString(),
      chainId: config.chainId,
      network: config.network,
      // Operational visibility: how many receipts the replay guard is holding.
      consumedReceipts: facilitator.store.size,
    }),
  )

  app.get('/.well-known/x402', (context) =>
    context.json({
      x402Version: X402_VERSION,
      resources: [requirements],
    }),
  )

  app.get(INSIGHTS_PATH, async (context) => {
    const header = context.req.header(PAYMENT_HEADER)

    if (header === undefined || header.trim() === '') {
      return refuse(
        context,
        new PaymentError(
          'payment_required',
          `Payment required: ${config.priceDisplay} ${config.tokenSymbol}. ` +
            `Charge a GiwaCard via ${SETTLEMENT_CALL} on ${config.vaultAddress}, then retry with the ` +
            `${PAYMENT_HEADER} header. See "accepts" for the full requirements.`,
        ),
      )
    }

    let payment
    try {
      payment = decodePaymentHeader(header, { network: config.network })
    } catch (error) {
      if (error instanceof PaymentError) return refuse(context, error)
      throw error
    }

    let proof: ChargeProof
    try {
      proof = await facilitator.verify({
        transactionHash: payment.payload.transactionHash,
        cardId: payment.payload.cardId,
        minAmount: config.priceAtomic,
      })
    } catch (error) {
      if (error instanceof PaymentError) return refuse(context, error)
      throw error
    }

    // Payment is verified and the receipt is consumed. If we now fail to build
    // the product, the client has paid for nothing — so hand the receipt back
    // and let them retry with it rather than charging a second card.
    let report: GiwaInsightsReport
    try {
      report = await generateInsightsReport(insightsReader, {
        blockCount: config.insights.blockCount,
        concurrency: config.insights.concurrency,
        chain: { id: config.chainId, name: giwaSepolia.name, network: config.network },
        now,
      })
    } catch (cause) {
      facilitator.release(payment.payload.transactionHash)
      return context.json(
        {
          error:
            'Payment verified, but the report could not be generated because the GIWA RPC was ' +
            'unreachable. Your receipt has been released — retry the same request with the same ' +
            `${PAYMENT_HEADER} header; you will not be charged twice.`,
          reason: 'report_unavailable',
          receiptReleased: true,
          transaction: payment.payload.transactionHash,
          detail: cause instanceof Error ? cause.message : String(cause),
        },
        503,
      )
    }

    context.header(PAYMENT_RESPONSE_HEADER, encodeSettlementHeader(
      buildSettlement(config, proof, now()),
    ))
    // Browsers cannot read a custom response header unless it is exposed.
    context.header('Access-Control-Expose-Headers', PAYMENT_RESPONSE_HEADER)
    return context.json(report)
  })

  return app
}

/** A wired-up merchant: config, facilitator, chain client and HTTP app. */
export interface MerchantService {
  readonly config: MerchantConfig
  readonly app: Hono
  readonly facilitator: MerchantFacilitator
  readonly publicClient: MerchantPublicClient
}

/**
 * Wire a merchant against the real GIWA Sepolia RPC.
 *
 * Builds exactly one viem client — read-only, with the retry/backoff policy from
 * `chain.ts` — and shares it between the facilitator and the report generator.
 * No wallet client is created, because the merchant never signs anything.
 */
export function createMerchantService(
  config: MerchantConfig,
  clientOptions: MerchantClientOptions = {},
): MerchantService {
  const publicClient = createMerchantPublicClient({
    ...clientOptions,
    transport: { url: config.rpcUrl, ...clientOptions.transport },
  })

  const facilitator = new MerchantFacilitator({
    reader: createViemReceiptReader(publicClient),
    vault: config.vaultAddress as Address,
    merchant: config.merchantAddress as Address,
  })

  const app = createMerchantApp({
    config,
    facilitator,
    insightsReader: createViemInsightsReader(publicClient),
  })

  return { config, app, facilitator, publicClient }
}

/**
 * Convenience wrapper: read configuration from the environment and wire it up.
 *
 * @throws {import('./config.js').MerchantConfigError} when configuration is
 * missing or malformed.
 */
export function createMerchantServiceFromEnv(env: EnvBag): MerchantService {
  return createMerchantService(loadMerchantConfig(env))
}

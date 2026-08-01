/**
 * The GiwaCard demo merchant: a paid API that answers HTTP 402 with payment
 * requirements, then settles the card it is presented and serves its product.
 *
 * The product is "GIWA Insights" (see `insights.ts`), priced at 1 gUSD per
 * request. The payment scheme is x402-shaped but settled by `CardVault.charge`
 * rather than Permit2 (see `x402.ts` for why), and the merchant is the party
 * that submits that charge — the contract requires `msg.sender ==
 * card.merchantScope` and pays `msg.sender`, so there is no other direction it
 * could go (KTD-9). The merchant's own facilitator does the charging and then
 * verifies the `CardCharged` event on its own receipt (`verify.ts`).
 *
 * This module is the library surface: `createMerchantApp` returns a Hono app you
 * can mount anywhere `fetch` exists. `src/server.ts` is the standalone binary.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Address } from 'viem'

import {
  createMerchantPublicClient,
  createMerchantWalletClient,
  giwaSepolia,
  giwaSepoliaExplorer,
  type MerchantClientOptions,
  type MerchantPublicClient,
  type MerchantWalletClient,
} from './chain.js'
import { loadMerchantConfig, type EnvBag, type MerchantConfig } from './config.js'
import {
  createViemInsightsReader,
  generateInsightsReport,
  type GiwaInsightsReport,
  type InsightsReader,
} from './insights.js'
import {
  createViemChargeSubmitter,
  MerchantFacilitator,
  type ChargeProof,
} from './verify.js'
import {
  assertExpectedVenue,
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
  /** Facilitator that charges presented cards and verifies the result. */
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
 * Paid: `GET /insights` — 1 gUSD, settled by the merchant calling
 * `CardVault.charge` on the card the client presents.
 */
export function createMerchantApp(options: MerchantAppOptions): Hono {
  const { config, facilitator, insightsReader } = options
  const now = options.now ?? (() => new Date())

  const requirements: PaymentRequirements = buildPaymentRequirements(
    config,
    INSIGHTS_RESOURCE,
  )

  const app = new Hono()

  /** 402 (or 503) with the full requirements body. Always the same shape. */
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
        `Mint a GiwaCard scoped to ${config.merchantAddress} with a cap of at least ` +
          `${requirements.maxAmountRequired} base units, in vault ${config.vaultAddress}.`,
        `Retry the request with ${PAYMENT_HEADER}: base64({"payload":{"cardId":"<id>"}}). ` +
          'You do not submit any transaction and you spend no gas.',
        `The merchant submits ${SETTLEMENT_CALL} itself and returns the report with a ` +
          `${PAYMENT_RESPONSE_HEADER} receipt naming the settlement transaction.`,
      ],
      settledBy: requirements.extra.settledBy,
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
      // Operational visibility: how many cards the replay guard is holding.
      settledCards: facilitator.store.size,
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
            `Mint a GiwaCard in vault ${config.vaultAddress} scoped to ${config.merchantAddress}, ` +
            `then retry with the ${PAYMENT_HEADER} header naming its card id. The merchant ` +
            'charges the card itself. See "accepts" for the full requirements.',
        ),
      )
    }

    let payment
    try {
      payment = decodePaymentHeader(header, { network: config.network })
      assertExpectedVenue(payment.payload, {
        vault: config.vaultAddress,
        chainId: config.chainId,
      })
    } catch (error) {
      if (error instanceof PaymentError) return refuse(context, error)
      throw error
    }

    const cardId = payment.payload.cardId

    // A card whose charge landed but whose report never shipped is already paid
    // for. Collecting it from the recorded proof is the only honest option: the
    // card is `Used` onchain, so there is nothing left to charge. `takeSettled`
    // is atomic, so a burst of retries still ships exactly one report.
    let proof = facilitator.takeSettled(cardId)
    if (proof === null) {
      try {
        proof = await facilitator.settle({ cardId, amount: config.priceAtomic })
      } catch (error) {
        if (error instanceof PaymentError) return refuse(context, error)
        throw error
      }
    }

    // The card is charged and the money has moved. If we now fail to build the
    // product the buyer cannot pay again — the card is spent — so the
    // settlement goes back on record and the same card id collects the report
    // on a retry, without a second charge.
    let report: GiwaInsightsReport
    try {
      report = await generateInsightsReport(insightsReader, {
        blockCount: config.insights.blockCount,
        concurrency: config.insights.concurrency,
        chain: { id: config.chainId, name: giwaSepolia.name, network: config.network },
        now,
      })
    } catch (cause) {
      facilitator.returnUndelivered(cardId, proof)
      return context.json(
        {
          error:
            'Your card was charged and the payment is settled, but the report could not be ' +
            'generated because the GIWA RPC was unreachable. Retry the same request with the ' +
            `same ${PAYMENT_HEADER} header — the card will not be charged twice.`,
          reason: 'report_unavailable',
          settled: true,
          transaction: proof.transactionHash,
          cardId: cardId.toString(),
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

/** A wired-up merchant: config, facilitator, chain clients and HTTP app. */
export interface MerchantService {
  readonly config: MerchantConfig
  readonly app: Hono
  readonly facilitator: MerchantFacilitator
  readonly publicClient: MerchantPublicClient
  /** Bound to the merchant's funded key. Only the facilitator uses it. */
  readonly walletClient: MerchantWalletClient
}

/**
 * Wire a merchant against the real GIWA Sepolia RPC.
 *
 * Builds one read client — with the retry/backoff policy from `chain.ts` —
 * shared between the facilitator and the report generator, plus one wallet
 * client bound to the merchant's key. The wallet client is handed to the
 * facilitator's submitter and to nothing else.
 */
export function createMerchantService(
  config: MerchantConfig,
  clientOptions: MerchantClientOptions = {},
): MerchantService {
  const transport = { url: config.rpcUrl, ...clientOptions.transport }
  const publicClient = createMerchantPublicClient({ ...clientOptions, transport })
  const walletClient = createMerchantWalletClient({
    ...clientOptions,
    transport,
    privateKey: config.merchantPrivateKey,
  })

  const facilitator = new MerchantFacilitator({
    submitter: createViemChargeSubmitter({
      wallet: walletClient,
      receipts: publicClient,
      vault: config.vaultAddress as Address,
    }),
    vault: config.vaultAddress as Address,
    merchant: config.merchantAddress as Address,
  })

  const app = createMerchantApp({
    config,
    facilitator,
    insightsReader: createViemInsightsReader(publicClient),
  })

  return { config, app, facilitator, publicClient, walletClient }
}

/**
 * Convenience wrapper: read configuration from the environment and wire it up.
 *
 * @throws {import('./config.js').MerchantConfigError} when configuration is
 * missing or malformed — including a missing or mismatched `MERCHANT_PRIVATE_KEY`.
 */
export function createMerchantServiceFromEnv(env: EnvBag): MerchantService {
  return createMerchantService(loadMerchantConfig(env))
}

import { describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'

import type { MerchantConfig } from '../src/config.js'
import { INSIGHTS_PATH, createMerchantApp } from '../src/index.js'
import type { GiwaInsightsReport } from '../src/insights.js'
import { MerchantFacilitator, type ChargeReceipt } from '../src/verify.js'
import {
  GIWA_VAULT_CHARGE_SCHEME,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  X402_VERSION,
  decodeSettlementHeader,
  encodePaymentHeader,
  type PaymentErrorCode,
  type PaymentRequiredBody,
} from '../src/x402.js'

import {
  IMPOSTOR_VAULT,
  MERCHANT_ADDRESS,
  ONE_GUSD,
  OTHER_MERCHANT,
  StubInsightsReader,
  StubReceiptReader,
  TOKEN_ADDRESS,
  VAULT_ADDRESS,
  VAULT_OWNER,
  cardChargedLog,
  chargeReceipt,
  makeBlockRun,
  testConfig,
  txHash,
} from './fixtures.js'

const NOW = () => new Date('2026-08-01T12:00:00.000Z')

interface Harness {
  app: Hono
  config: MerchantConfig
  facilitator: MerchantFacilitator
  receipts: StubReceiptReader
  blocks: StubInsightsReader
}

/** Wire an app over stub chain readers. Nothing here touches a live RPC. */
function harness(
  options: { receipts?: readonly ChargeReceipt[]; config?: MerchantConfig } = {},
): Harness {
  const config = options.config ?? testConfig()
  const receipts = new StubReceiptReader(options.receipts ?? [chargeReceipt()])
  const blocks = new StubInsightsReader(makeBlockRun(1_000n, 5))
  const facilitator = new MerchantFacilitator({
    reader: receipts,
    vault: config.vaultAddress,
    merchant: config.merchantAddress,
  })
  const app = createMerchantApp({ config, facilitator, insightsReader: blocks, now: NOW })
  return { app, config, facilitator, receipts, blocks }
}

/** A well-formed X-PAYMENT header for the given receipt. */
function paymentHeader(hash = txHash(1), cardId = 1n, network = 'giwa-sepolia'): string {
  return encodePaymentHeader({
    x402Version: X402_VERSION,
    scheme: GIWA_VAULT_CHARGE_SCHEME,
    network,
    payload: { transactionHash: hash, cardId },
  })
}

/** Request the paid resource with an optional payment header. */
async function buy(app: Hono, header?: string): Promise<Response> {
  return await app.request(INSIGHTS_PATH, {
    headers: header === undefined ? {} : { [PAYMENT_HEADER]: header },
  })
}

/** Assert a 402 and return its body. */
async function expect402(response: Response, reason: PaymentErrorCode) {
  expect(response.status).toBe(402)
  const body = (await response.json()) as PaymentRequiredBody
  expect(body.reason).toBe(reason)
  return body
}

describe('free endpoints', () => {
  test('GET / describes the service, its price and how to pay', async () => {
    const { app } = harness()
    const response = await app.request('/')
    expect(response.status).toBe(200)

    const body = (await response.json()) as Record<string, unknown>
    expect(body['service']).toBe('GIWA Insights')
    expect(body['price']).toBe('1 gUSD')
    expect(body['priceAtomic']).toBe('1000000')
    expect(body['merchant']).toBe(MERCHANT_ADDRESS)
    expect(body['vault']).toBe(VAULT_ADDRESS)
    expect(body['asset']).toBe(TOKEN_ADDRESS)
    expect(body['chainId']).toBe(91_342)
    expect(body['releasePolicy']).toBe('sequencer-block')
    expect(Array.isArray(body['howToPay'])).toBe(true)
    expect((body['howToPay'] as string[]).join(' ')).toContain('CardVault.charge')
  })

  test('GET /health reports liveness and replay-store size', async () => {
    const { app } = harness()
    const response = await app.request('/health')
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body['status']).toBe('ok')
    expect(body['consumedReceipts']).toBe(0)
  })

  test('GET /.well-known/x402 advertises the paid resource', async () => {
    const { app } = harness()
    const response = await app.request('/.well-known/x402')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { x402Version: number; resources: unknown[] }
    expect(body.x402Version).toBe(1)
    expect(body.resources).toHaveLength(1)
    expect(JSON.stringify(body.resources)).toContain('/insights')
  })

  test('free endpoints never require payment', async () => {
    const { app } = harness()
    for (const path of ['/', '/health', '/.well-known/x402']) {
      expect((await app.request(path)).status).toBe(200)
    }
  })
})

describe('GET /insights — no payment', () => {
  test('answers 402 with requirements carrying every field the client needs', async () => {
    const { app } = harness()
    const response = await buy(app)
    const body = await expect402(response, 'payment_required')

    expect(body.x402Version).toBe(1)
    expect(body.error).toContain('1 gUSD')
    expect(body.accepts).toHaveLength(1)

    const requirements = body.accepts[0]
    expect(requirements).toBeDefined()
    if (requirements === undefined) return

    // Who to pay, how much, in what, through which contract, on which chain.
    expect(requirements.scheme).toBe('giwa-vault-charge')
    expect(requirements.network).toBe('giwa-sepolia')
    expect(requirements.payTo).toBe(MERCHANT_ADDRESS)
    expect(requirements.maxAmountRequired).toBe('1000000')
    expect(requirements.asset).toBe(TOKEN_ADDRESS)
    expect(requirements.extra.vault).toBe(VAULT_ADDRESS)
    expect(requirements.extra.chainId).toBe(91_342)
    expect(requirements.extra.tokenSymbol).toBe('gUSD')
    expect(requirements.extra.tokenDecimals).toBe(6)
    expect(requirements.resource).toBe('https://insights.giwacard.test/insights')
    expect(requirements.description).toContain('GIWA Insights')
    expect(requirements.mimeType).toBe('application/json')
    expect(requirements.maxTimeoutSeconds).toBe(120)
    expect(requirements.extra.settlementCall).toContain('charge')
    expect(requirements.extra.settlementEvent).toContain('CardCharged')
    expect(requirements.extra.payloadFields).toEqual(['transactionHash', 'cardId'])
    expect(requirements.extra.releasePolicy).toBe('sequencer-block')
  })

  test('treats an empty X-PAYMENT header the same as an absent one', async () => {
    const { app } = harness()
    await expect402(await buy(app, '   '), 'payment_required')
  })

  test('sends no PAYMENT-RESPONSE header when nothing was settled', async () => {
    const { app } = harness()
    const response = await buy(app)
    expect(response.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull()
  })
})

describe('GET /insights — valid payment', () => {
  test('serves the report with a PAYMENT-RESPONSE settlement receipt', async () => {
    const { app } = harness()
    const response = await buy(app, paymentHeader())

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')

    const report = (await response.json()) as GiwaInsightsReport
    expect(report.product).toBe('GIWA Insights')
    expect(report.window.blocks).toBe(5)
    expect(report.activity.totalTransactions).toBe(13)
    expect(report.cadence.meanBlockSeconds).toBe(2)
    expect(report.highlights.length).toBeGreaterThan(0)

    const raw = response.headers.get(PAYMENT_RESPONSE_HEADER)
    expect(raw).not.toBeNull()
    const settlement = decodeSettlementHeader(raw ?? '')
    expect(settlement.success).toBe(true)
    expect(settlement.scheme).toBe('giwa-vault-charge')
    expect(settlement.network).toBe('giwa-sepolia')
    expect(settlement.transaction).toBe(txHash(1))
    expect(settlement.payer).toBe(VAULT_OWNER)
    expect(settlement.payee).toBe(MERCHANT_ADDRESS)
    expect(settlement.vault).toBe(VAULT_ADDRESS)
    expect(settlement.cardId).toBe('1')
    expect(settlement.amount).toBe(ONE_GUSD.toString())
    expect(settlement.released).toBe('4000000')
    expect(settlement.asset).toBe(TOKEN_ADDRESS)
    expect(settlement.blockNumber).toBe('1000')
    expect(settlement.releasePolicy).toBe('sequencer-block')
    expect(settlement.settledAt).toBe('2026-08-01T12:00:00.000Z')
  })

  test('exposes PAYMENT-RESPONSE to browsers', async () => {
    const { app } = harness()
    const response = await buy(app, paymentHeader())
    expect(response.headers.get('access-control-expose-headers')).toBe(
      PAYMENT_RESPONSE_HEADER,
    )
  })

  test('accepts an overpayment and reports the amount actually charged', async () => {
    const { app } = harness({
      receipts: [chargeReceipt({ logs: [cardChargedLog({ amount: ONE_GUSD * 3n })] })],
    })
    const response = await buy(app, paymentHeader())
    expect(response.status).toBe(200)
    const settlement = decodeSettlementHeader(
      response.headers.get(PAYMENT_RESPONSE_HEADER) ?? '',
    )
    expect(settlement.amount).toBe('3000000')
  })

  test('the paid response echoes nothing the client controls (AE7)', async () => {
    // The report is generated purely from chain reads. A merchant that echoed
    // client-supplied text back into its product would be a prompt-injection
    // surface for the buying agent; this one has no such field.
    const { app } = harness()
    const response = await buy(app, paymentHeader())
    const report = (await response.json()) as GiwaInsightsReport

    expect(Object.keys(report).sort()).toEqual([
      'activity',
      'cadence',
      'chain',
      'fees',
      'gas',
      'generatedAt',
      'highlights',
      'notes',
      'product',
      'reportVersion',
      'window',
    ])
    const serialised = JSON.stringify(report)
    expect(serialised).not.toContain(txHash(1))
    expect(serialised).not.toContain(MERCHANT_ADDRESS)
  })

  test('states the KTD-5 release policy in the delivered product', async () => {
    const { app } = harness()
    const response = await buy(app, paymentHeader())
    const report = (await response.json()) as GiwaInsightsReport
    expect(report.notes.join(' ')).toContain('KTD-5')
    expect(report.notes.join(' ')).toContain('sequencer block')
  })
})

describe('GET /insights — rejected payments', () => {
  test('rejects a malformed X-PAYMENT header with a clear reason', async () => {
    const { app } = harness()
    const body = await expect402(await buy(app, 'not-a-payment!'), 'malformed_payment_header')
    expect(body.error).toContain('transactionHash')
    expect(body.error).toContain('cardId')
    // The full requirements come back, so the client can just pay.
    expect(body.accepts[0]?.payTo).toBe(MERCHANT_ADDRESS)
  })

  test('rejects a payload missing the transaction hash', async () => {
    const { app } = harness()
    const header = Buffer.from(JSON.stringify({ payload: { cardId: '1' } })).toString('base64')
    await expect402(await buy(app, header), 'malformed_payment_header')
  })

  test('rejects a foreign scheme', async () => {
    const { app } = harness()
    const header = Buffer.from(
      JSON.stringify({
        scheme: 'exact_evm',
        payload: { transactionHash: txHash(1), cardId: '1' },
      }),
    ).toString('base64')
    await expect402(await buy(app, header), 'unsupported_scheme')
  })

  test('rejects a foreign network', async () => {
    const { app } = harness()
    await expect402(
      await buy(app, paymentHeader(txHash(1), 1n, 'base-sepolia')),
      'unsupported_network',
    )
  })

  test('rejects a hash the chain has never seen', async () => {
    const { app } = harness()
    await expect402(await buy(app, paymentHeader(txHash(777))), 'transaction_not_found')
  })

  test('rejects a reverted charge', async () => {
    const { app } = harness({ receipts: [chargeReceipt({ status: 'reverted' })] })
    await expect402(await buy(app, paymentHeader()), 'transaction_reverted')
  })

  test('rejects a receipt with no CardCharged event', async () => {
    const { app } = harness({ receipts: [chargeReceipt({ logs: [] })] })
    await expect402(await buy(app, paymentHeader()), 'no_charge_event')
  })

  test('rejects an event emitted by a lookalike contract, not the vault', async () => {
    const { app } = harness({
      receipts: [
        chargeReceipt({
          logs: [
            cardChargedLog({
              address: IMPOSTOR_VAULT,
              amount: ONE_GUSD * 1_000n,
            }),
          ],
        }),
      ],
    })
    const body = await expect402(await buy(app, paymentHeader()), 'wrong_vault')
    expect(body.error).toContain(VAULT_ADDRESS)
  })

  test('rejects a charge that paid a different merchant', async () => {
    const { app } = harness({
      receipts: [chargeReceipt({ logs: [cardChargedLog({ merchant: OTHER_MERCHANT })] })],
    })
    await expect402(await buy(app, paymentHeader()), 'wrong_merchant')
  })

  test('rejects a charge below the list price', async () => {
    const { app } = harness({
      receipts: [chargeReceipt({ logs: [cardChargedLog({ amount: ONE_GUSD - 1n })] })],
    })
    await expect402(await buy(app, paymentHeader()), 'amount_below_price')
  })

  test('rejects a cardId that does not match the charged card', async () => {
    const { app } = harness({
      receipts: [chargeReceipt({ logs: [cardChargedLog({ cardId: 99n })] })],
    })
    await expect402(await buy(app, paymentHeader(txHash(1), 1n)), 'card_id_mismatch')
  })

  test('every rejection returns the full requirements, so a client can recover', async () => {
    const cases: readonly [string, PaymentErrorCode][] = [
      ['not-a-payment!', 'malformed_payment_header'],
      [paymentHeader(txHash(777)), 'transaction_not_found'],
    ]
    const { app } = harness()
    for (const [header, reason] of cases) {
      const body = await expect402(await buy(app, header), reason)
      expect(body.accepts[0]?.maxAmountRequired).toBe('1000000')
      expect(body.accepts[0]?.extra.vault).toBe(VAULT_ADDRESS)
    }
  })

  test('a rejected payment serves no report', async () => {
    const { app } = harness({ receipts: [chargeReceipt({ logs: [] })] })
    const response = await buy(app, paymentHeader())
    const body = (await response.json()) as Record<string, unknown>
    expect(body['product']).toBeUndefined()
    expect(response.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull()
  })
})

describe('GET /insights — receipt replay', () => {
  test('rejects a transaction hash that already bought a report', async () => {
    const { app } = harness()
    expect((await buy(app, paymentHeader())).status).toBe(200)

    const body = await expect402(await buy(app, paymentHeader()), 'receipt_already_used')
    expect(body.error).toContain('already been redeemed')
  })

  test('refuses the replay without spending another RPC read', async () => {
    const { app, receipts } = harness()
    await buy(app, paymentHeader())
    await buy(app, paymentHeader())
    expect(receipts.calls).toBe(1)
  })

  test('two concurrent requests with the same receipt serve exactly one report', async () => {
    const { app } = harness()
    const [first, second] = await Promise.all([
      buy(app, paymentHeader()),
      buy(app, paymentHeader()),
    ])
    const statuses = [first?.status, second?.status].sort()
    expect(statuses).toEqual([200, 402])
  })

  test('a second, distinct charge buys a second report', async () => {
    const { app, receipts } = harness()
    receipts.set(
      chargeReceipt({ hash: txHash(2), logs: [cardChargedLog({ cardId: 2n })] }),
    )
    expect((await buy(app, paymentHeader(txHash(1), 1n))).status).toBe(200)
    expect((await buy(app, paymentHeader(txHash(2), 2n))).status).toBe(200)
  })

  test('the health endpoint reflects consumed receipts', async () => {
    const { app } = harness()
    await buy(app, paymentHeader())
    const body = (await (await app.request('/health')).json()) as Record<string, unknown>
    expect(body['consumedReceipts']).toBe(1)
  })
})

describe('GET /insights — merchant-side failures', () => {
  test('an unreadable chain is a 503, not a 402', async () => {
    const { app, receipts } = harness()
    receipts.failure = new Error('fetch failed')
    const response = await buy(app, paymentHeader())
    expect(response.status).toBe(503)
    const body = (await response.json()) as PaymentRequiredBody
    expect(body.reason).toBe('chain_unavailable')
  })

  test('a failed verification does not consume the receipt', async () => {
    const { app, receipts, facilitator } = harness()
    receipts.failure = new Error('fetch failed')
    await buy(app, paymentHeader())
    expect(facilitator.store.size).toBe(0)

    receipts.failure = null
    expect((await buy(app, paymentHeader())).status).toBe(200)
  })

  test('a report that cannot be generated releases the receipt so the buyer can retry', async () => {
    const { app, blocks } = harness()
    blocks.failure = new Error('429 Too Many Requests')

    const failed = await buy(app, paymentHeader())
    expect(failed.status).toBe(503)
    const body = (await failed.json()) as Record<string, unknown>
    expect(body['reason']).toBe('report_unavailable')
    expect(body['receiptReleased']).toBe(true)
    expect(body['transaction']).toBe(txHash(1))

    // Same receipt, second attempt: the buyer paid once and gets their report.
    blocks.failure = null
    const retried = await buy(app, paymentHeader())
    expect(retried.status).toBe(200)
    expect(retried.headers.get(PAYMENT_RESPONSE_HEADER)).not.toBeNull()
  })
})

describe('pricing is configurable end to end', () => {
  test('a 2.5 gUSD price rejects a 1 gUSD charge and accepts a 3 gUSD one', async () => {
    const config = testConfig({ priceGusd: '2.5' })
    const cheap = harness({ config })
    await expect402(await buy(cheap.app, paymentHeader()), 'amount_below_price')

    const rich = harness({
      config,
      receipts: [chargeReceipt({ logs: [cardChargedLog({ amount: 3_000_000n })] })],
    })
    expect((await buy(rich.app, paymentHeader())).status).toBe(200)

    const requirements = await expect402(await buy(cheap.app), 'payment_required')
    expect(requirements.accepts[0]?.maxAmountRequired).toBe('2500000')
  })
})

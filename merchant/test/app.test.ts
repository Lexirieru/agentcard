import { describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'

import type { MerchantConfig } from '../src/config.js'
import { INSIGHTS_PATH, createMerchantApp } from '../src/index.js'
import type { GiwaInsightsReport } from '../src/insights.js'
import { MerchantFacilitator } from '../src/verify.js'
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
  StubChargeSubmitter,
  StubInsightsReader,
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
  submitter: StubChargeSubmitter
  blocks: StubInsightsReader
}

/** Wire an app over stubbed chain access. Nothing here touches a live RPC. */
function harness(
  options: { submitter?: StubChargeSubmitter; config?: MerchantConfig } = {},
): Harness {
  const config = options.config ?? testConfig()
  const submitter = options.submitter ?? new StubChargeSubmitter()
  const blocks = new StubInsightsReader(makeBlockRun(1_000n, 5))
  const facilitator = new MerchantFacilitator({
    submitter,
    vault: config.vaultAddress,
    merchant: config.merchantAddress,
  })
  const app = createMerchantApp({ config, facilitator, insightsReader: blocks, now: NOW })
  return { app, config, facilitator, submitter, blocks }
}

/** A well-formed X-PAYMENT header presenting a card. */
function paymentHeader(
  cardId = 1n,
  overrides: { network?: string; vault?: `0x${string}`; chainId?: number } = {},
): string {
  return encodePaymentHeader({
    x402Version: X402_VERSION,
    scheme: GIWA_VAULT_CHARGE_SCHEME,
    network: overrides.network ?? 'giwa-sepolia',
    payload: {
      cardId,
      ...(overrides.vault !== undefined ? { vault: overrides.vault } : {}),
      ...(overrides.chainId !== undefined ? { chainId: overrides.chainId } : {}),
    },
  })
}

/** Request the paid resource with an optional payment header. */
async function buy(app: Hono, header?: string): Promise<Response> {
  return await app.request(INSIGHTS_PATH, {
    headers: header === undefined ? {} : { [PAYMENT_HEADER]: header },
  })
}

/** Assert a refusal with a given status and reason, and return its body. */
async function expectRefusal(
  response: Response,
  status: 402 | 503,
  reason: PaymentErrorCode,
) {
  expect(response.status).toBe(status)
  const body = (await response.json()) as PaymentRequiredBody
  expect(body.reason).toBe(reason)
  return body
}

/** Assert a 402 and return its body. */
async function expect402(response: Response, reason: PaymentErrorCode) {
  return await expectRefusal(response, 402, reason)
}

describe('free endpoints', () => {
  test('GET / describes the service, its price and who charges the card', async () => {
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
    expect(body['settledBy']).toBe('merchant')
    expect(body['releasePolicy']).toBe('sequencer-block')

    // The direction of the payment is stated, not implied.
    const howToPay = (body['howToPay'] as string[]).join(' ')
    expect(howToPay).toContain('CardVault.charge')
    expect(howToPay).toContain('The merchant submits')
    expect(howToPay).toContain('spend no gas')
  })

  test('GET /health reports liveness and replay-store size', async () => {
    const { app } = harness()
    const response = await app.request('/health')
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body['status']).toBe('ok')
    expect(body['settledCards']).toBe(0)
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

    // Who charges, how much, in what, through which contract, on which chain.
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
    expect(requirements.extra.payloadFields).toEqual(['cardId', 'vault', 'chainId'])
    expect(requirements.extra.releasePolicy).toBe('sequencer-block')
  })

  test('the requirements say the merchant submits the charge', async () => {
    // The bug this suite exists to prevent: a client that reads "settlementCall"
    // and concludes it must submit that call itself gets a MerchantScopeMismatch
    // revert and pays nobody. `settledBy` is what stops the guessing.
    const { app } = harness()
    const body = await expect402(await buy(app), 'payment_required')
    expect(body.accepts[0]?.extra.settledBy).toBe('merchant')
    expect(body.error).toContain('The merchant charges the card itself')
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

  test('charges nothing when no card is presented', async () => {
    const { app, submitter } = harness()
    await buy(app)
    expect(submitter.calls).toHaveLength(0)
  })
})

describe('GET /insights — the merchant settles a presented card', () => {
  test('charges the card for exactly the list price', async () => {
    const { app, submitter } = harness()
    expect((await buy(app, paymentHeader(7n))).status).toBe(200)
    expect(submitter.calls).toEqual([{ cardId: 7n, amount: ONE_GUSD }])
  })

  test('serves the report with a PAYMENT-RESPONSE settlement receipt', async () => {
    const { app } = harness()
    const response = await buy(app, paymentHeader(1n))

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
    // The receipt is the merchant's *own* transaction hash.
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

  test('accepts a client that states the vault and chain it expects', async () => {
    const { app } = harness()
    const header = paymentHeader(1n, { vault: VAULT_ADDRESS, chainId: 91_342 })
    expect((await buy(app, header)).status).toBe(200)
  })

  test('exposes PAYMENT-RESPONSE to browsers', async () => {
    const { app } = harness()
    const response = await buy(app, paymentHeader(1n))
    expect(response.headers.get('access-control-expose-headers')).toBe(
      PAYMENT_RESPONSE_HEADER,
    )
  })

  test('reports the amount the vault actually moved, not the amount asked for', async () => {
    const { app, submitter } = harness()
    submitter.set(
      1n,
      chargeReceipt({ logs: [cardChargedLog({ amount: ONE_GUSD * 3n })] }),
    )
    const response = await buy(app, paymentHeader(1n))
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
    const response = await buy(app, paymentHeader(1n))
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
    const response = await buy(app, paymentHeader(1n))
    const report = (await response.json()) as GiwaInsightsReport
    expect(report.notes.join(' ')).toContain('KTD-5')
    expect(report.notes.join(' ')).toContain('sequencer block')
  })
})

describe('GET /insights — malformed presentations', () => {
  test('rejects a malformed X-PAYMENT header with a clear reason', async () => {
    const { app } = harness()
    const body = await expect402(await buy(app, 'not-a-payment!'), 'malformed_payment_header')
    expect(body.error).toContain('cardId')
    expect(body.error).not.toContain('transactionHash')
    // The full requirements come back, so the client can just pay.
    expect(body.accepts[0]?.payTo).toBe(MERCHANT_ADDRESS)
  })

  test('rejects a payload with no cardId', async () => {
    const { app } = harness()
    const header = Buffer.from(JSON.stringify({ payload: {} })).toString('base64')
    await expect402(await buy(app, header), 'malformed_payment_header')
  })

  test('rejects a foreign scheme', async () => {
    const { app } = harness()
    const header = Buffer.from(
      JSON.stringify({ scheme: 'exact_evm', payload: { cardId: '1' } }),
    ).toString('base64')
    await expect402(await buy(app, header), 'unsupported_scheme')
  })

  test('rejects a foreign network', async () => {
    const { app } = harness()
    await expect402(
      await buy(app, paymentHeader(1n, { network: 'base-sepolia' })),
      'unsupported_network',
    )
  })

  test('rejects a client that expects a different vault, before spending gas', async () => {
    const { app, submitter } = harness()
    const body = await expect402(
      await buy(app, paymentHeader(1n, { vault: IMPOSTOR_VAULT })),
      'vault_mismatch',
    )
    expect(body.error).toContain(VAULT_ADDRESS)
    expect(submitter.calls).toHaveLength(0)
  })

  test('rejects a client that expects a different chain, before spending gas', async () => {
    const { app, submitter } = harness()
    await expect402(await buy(app, paymentHeader(1n, { chainId: 8_453 })), 'unsupported_network')
    expect(submitter.calls).toHaveLength(0)
  })

  test('a malformed presentation charges nothing', async () => {
    const { app, submitter } = harness()
    await buy(app, 'not-a-payment!')
    await buy(app, paymentHeader(1n, { network: 'base-sepolia' }))
    expect(submitter.calls).toHaveLength(0)
  })
})

describe('GET /insights — the vault refuses the charge', () => {
  /** Every vault refusal is a 402 the buyer can act on, never a crash. */
  const refusals: readonly [PaymentErrorCode, string][] = [
    ['merchant_scope_mismatch', 'scoped to a different merchant'],
    ['card_already_used', 'already been charged'],
    ['card_not_active', 'not active'],
    ['card_expired', 'expired'],
    ['card_cap_too_low', 'cap below'],
  ]

  for (const [reason] of refusals) {
    test(`${reason} is a clean 402 with the full requirements`, async () => {
      const submitter = new StubChargeSubmitter()
      submitter.refuseWith = reason
      const { app } = harness({ submitter })

      const body = await expect402(await buy(app, paymentHeader(4n)), reason)
      expect(body.accepts[0]?.maxAmountRequired).toBe('1000000')
      expect(body.accepts[0]?.extra.vault).toBe(VAULT_ADDRESS)
    })
  }

  test('a card scoped to another merchant serves no report and frees the card id', async () => {
    const submitter = new StubChargeSubmitter()
    submitter.refuseWith = 'merchant_scope_mismatch'
    const { app, facilitator } = harness({ submitter })

    const response = await buy(app, paymentHeader(4n))
    expect(response.status).toBe(402)
    const body = (await response.json()) as Record<string, unknown>
    expect(body['product']).toBeUndefined()
    expect(response.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull()

    // Nothing was settled, so the card id is not burned by the attempt.
    expect(facilitator.store.has(4n)).toBe(false)
  })

  test('a refused card can be presented again once its scope is fixed', async () => {
    const submitter = new StubChargeSubmitter()
    submitter.refuseWith = 'merchant_scope_mismatch'
    const { app } = harness({ submitter })

    await expect402(await buy(app, paymentHeader(4n)), 'merchant_scope_mismatch')
    submitter.refuseWith = null
    expect((await buy(app, paymentHeader(4n))).status).toBe(200)
  })
})

describe('GET /insights — one card, one report', () => {
  test('rejects a cardId that already bought a report', async () => {
    const { app } = harness()
    expect((await buy(app, paymentHeader(1n))).status).toBe(200)

    const body = await expect402(await buy(app, paymentHeader(1n)), 'card_already_settled')
    expect(body.error).toContain('already been settled')
  })

  test('refuses the replay without submitting a second charge', async () => {
    const { app, submitter } = harness()
    await buy(app, paymentHeader(1n))
    await buy(app, paymentHeader(1n))
    expect(submitter.calls).toHaveLength(1)
  })

  test('two concurrent requests with the same card serve exactly one report', async () => {
    const { app, submitter } = harness()
    const [first, second] = await Promise.all([
      buy(app, paymentHeader(1n)),
      buy(app, paymentHeader(1n)),
    ])
    const statuses = [first?.status, second?.status].sort()
    expect(statuses).toEqual([200, 402])
    expect(submitter.calls).toHaveLength(1)
  })

  test('a second, distinct card buys a second report', async () => {
    const { app } = harness()
    expect((await buy(app, paymentHeader(1n))).status).toBe(200)
    expect((await buy(app, paymentHeader(2n))).status).toBe(200)
  })

  test('the health endpoint reflects settled cards', async () => {
    const { app } = harness()
    await buy(app, paymentHeader(1n))
    const body = (await (await app.request('/health')).json()) as Record<string, unknown>
    expect(body['settledCards']).toBe(1)
  })
})

describe('GET /insights — merchant-side failures', () => {
  test('an unfunded merchant key is a 503, not a 402', async () => {
    const submitter = new StubChargeSubmitter()
    submitter.failure = new Error(
      'insufficient funds for intrinsic transaction cost',
    )
    const { app } = harness({ submitter })

    const response = await buy(app, paymentHeader(1n))
    const body = await expectRefusal(response, 503, 'settlement_failed')
    expect(body.error).toContain('no ETH for gas')
    expect(body.error).toContain('your card was not charged')
  })

  test('an unreadable chain is a 503, not a 402', async () => {
    const submitter = new StubChargeSubmitter()
    submitter.failure = new Error('fetch failed')
    const { app } = harness({ submitter })
    await expectRefusal(await buy(app, paymentHeader(1n)), 503, 'settlement_failed')
  })

  test('a settlement that never happened does not burn the card id', async () => {
    const submitter = new StubChargeSubmitter()
    submitter.failure = new Error('insufficient funds')
    const { app, facilitator } = harness({ submitter })

    await buy(app, paymentHeader(1n))
    expect(facilitator.store.size).toBe(0)

    submitter.failure = null
    expect((await buy(app, paymentHeader(1n))).status).toBe(200)
  })

  test('a settlement whose event came from a lookalike contract is a 503', async () => {
    const submitter = new StubChargeSubmitter().set(
      1n,
      chargeReceipt({
        logs: [cardChargedLog({ address: IMPOSTOR_VAULT, amount: ONE_GUSD * 1_000n })],
      }),
    )
    const { app } = harness({ submitter })
    const body = await expectRefusal(await buy(app, paymentHeader(1n)), 503, 'wrong_vault')
    expect(body.error).toContain(VAULT_ADDRESS)
  })

  test('a settlement that paid a different merchant is a 503', async () => {
    const submitter = new StubChargeSubmitter().set(
      1n,
      chargeReceipt({ logs: [cardChargedLog({ merchant: OTHER_MERCHANT })] }),
    )
    const { app } = harness({ submitter })
    await expectRefusal(await buy(app, paymentHeader(1n)), 503, 'wrong_merchant')
  })

  test('a settlement that moved less than the price is a 503', async () => {
    const submitter = new StubChargeSubmitter().set(
      1n,
      chargeReceipt({ logs: [cardChargedLog({ amount: ONE_GUSD - 1n })] }),
    )
    const { app } = harness({ submitter })
    await expectRefusal(await buy(app, paymentHeader(1n)), 503, 'amount_below_price')
  })

  test('a settlement with no CardCharged event is a 503', async () => {
    const submitter = new StubChargeSubmitter().set(1n, chargeReceipt({ logs: [] }))
    const { app } = harness({ submitter })
    await expectRefusal(await buy(app, paymentHeader(1n)), 503, 'no_charge_event')
  })

  test('a report that cannot be generated is retryable with the same card', async () => {
    const { app, blocks, submitter } = harness()
    blocks.failure = new Error('429 Too Many Requests')

    const failed = await buy(app, paymentHeader(1n))
    expect(failed.status).toBe(503)
    const body = (await failed.json()) as Record<string, unknown>
    expect(body['reason']).toBe('report_unavailable')
    expect(body['settled']).toBe(true)
    expect(body['transaction']).toBe(txHash(1))
    expect(body['cardId']).toBe('1')

    // The card is `Used` onchain — the buyer cannot pay again even if we asked
    // them to. So the retry must serve the report off the recorded settlement,
    // without a second charge.
    blocks.failure = null
    const retried = await buy(app, paymentHeader(1n))
    expect(retried.status).toBe(200)
    expect(retried.headers.get(PAYMENT_RESPONSE_HEADER)).not.toBeNull()
    expect(submitter.calls).toHaveLength(1)
  })

  test('concurrent retries of an owed report ship it exactly once', async () => {
    const { app, blocks, submitter } = harness()
    blocks.failure = new Error('429 Too Many Requests')
    await buy(app, paymentHeader(1n))
    blocks.failure = null

    const [first, second] = await Promise.all([
      buy(app, paymentHeader(1n)),
      buy(app, paymentHeader(1n)),
    ])
    expect([first?.status, second?.status].sort()).toEqual([200, 402])
    // And neither retry charged anything: the card was already spent.
    expect(submitter.calls).toHaveLength(1)
  })

  test('a delivered report cannot be re-fetched with the same card', async () => {
    const { app, blocks } = harness()
    blocks.failure = new Error('429 Too Many Requests')
    await buy(app, paymentHeader(1n))
    blocks.failure = null
    expect((await buy(app, paymentHeader(1n))).status).toBe(200)
    await expect402(await buy(app, paymentHeader(1n)), 'card_already_settled')
  })
})

describe('pricing is configurable end to end', () => {
  test('a 2.5 gUSD price charges 2.5 gUSD and advertises it', async () => {
    const config = testConfig({ priceGusd: '2.5' })
    const { app, submitter } = harness({ config })

    expect((await buy(app, paymentHeader(1n))).status).toBe(200)
    expect(submitter.calls).toEqual([{ cardId: 1n, amount: 2_500_000n }])

    const requirements = await expect402(await buy(app), 'payment_required')
    expect(requirements.accepts[0]?.maxAmountRequired).toBe('2500000')
  })

  test('a card whose charge moved less than the configured price is refused', async () => {
    const config = testConfig({ priceGusd: '2.5' })
    const submitter = new StubChargeSubmitter().set(
      1n,
      chargeReceipt({ logs: [cardChargedLog({ amount: ONE_GUSD })] }),
    )
    const { app } = harness({ config, submitter })
    await expectRefusal(await buy(app, paymentHeader(1n)), 503, 'amount_below_price')
  })
})

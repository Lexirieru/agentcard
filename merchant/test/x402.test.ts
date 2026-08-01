import { describe, expect, test } from 'bun:test'

import {
  GIWA_VAULT_CHARGE_SCHEME,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PaymentError,
  RELEASE_POLICY,
  SETTLEMENT_CALL,
  SETTLEMENT_EVENT,
  X402_VERSION,
  buildPaymentRequiredBody,
  buildPaymentRequirements,
  decodePaymentHeader,
  decodeSettlementHeader,
  encodePaymentHeader,
  encodeSettlementHeader,
  httpStatusForPaymentError,
  type PaymentErrorCode,
  type SettlementResponse,
} from '../src/x402.js'

import {
  MERCHANT_ADDRESS,
  ONE_GUSD,
  TOKEN_ADDRESS,
  VAULT_ADDRESS,
  VAULT_OWNER,
  testConfig,
  txHash,
} from './fixtures.js'

const config = testConfig()
const resource = { path: '/insights', description: 'GIWA Insights report.' }
const decodeOptions = { network: config.network }

/** Encode an arbitrary object the way a client would. */
function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

describe('header names stay in the x402 family', () => {
  test('uses X-PAYMENT and PAYMENT-RESPONSE verbatim', () => {
    expect(PAYMENT_HEADER).toBe('X-PAYMENT')
    expect(PAYMENT_RESPONSE_HEADER).toBe('PAYMENT-RESPONSE')
    expect(X402_VERSION).toBe(1)
  })

  test('names a scheme of our own rather than pretending to be exact_evm', () => {
    expect(GIWA_VAULT_CHARGE_SCHEME).toBe('giwa-vault-charge')
    expect(GIWA_VAULT_CHARGE_SCHEME).not.toBe('exact')
    expect(GIWA_VAULT_CHARGE_SCHEME).not.toBe('exact_evm')
  })
})

describe('buildPaymentRequirements', () => {
  const requirements = buildPaymentRequirements(config, resource)

  test('carries every field a client needs to pay without a second round trip', () => {
    expect(requirements.scheme).toBe(GIWA_VAULT_CHARGE_SCHEME)
    expect(requirements.network).toBe('giwa-sepolia')
    expect(requirements.maxAmountRequired).toBe(ONE_GUSD.toString())
    expect(requirements.payTo).toBe(MERCHANT_ADDRESS)
    expect(requirements.asset).toBe(TOKEN_ADDRESS)
    expect(requirements.resource).toBe('https://insights.giwacard.test/insights')
    expect(requirements.description).toBe('GIWA Insights report.')
    expect(requirements.mimeType).toBe('application/json')
    expect(requirements.maxTimeoutSeconds).toBeGreaterThan(0)
  })

  test('carries the vault and chain id, which stock x402 has no field for', () => {
    expect(requirements.extra.vault).toBe(VAULT_ADDRESS)
    expect(requirements.extra.chainId).toBe(91_342)
    expect(requirements.extra.tokenSymbol).toBe('gUSD')
    expect(requirements.extra.tokenDecimals).toBe(6)
    expect(requirements.extra.priceDisplay).toBe('1')
  })

  test('tells the client which call to make and which event will be checked', () => {
    expect(requirements.extra.settlementCall).toBe(SETTLEMENT_CALL)
    expect(requirements.extra.settlementCall).toContain('charge')
    expect(requirements.extra.settlementEvent).toBe(SETTLEMENT_EVENT)
    expect(requirements.extra.settlementEvent).toContain('CardCharged')
    expect(requirements.extra.payloadFields).toEqual(['transactionHash', 'cardId'])
  })

  test('states the KTD-5 release policy on the wire', () => {
    expect(requirements.extra.releasePolicy).toBe(RELEASE_POLICY)
    expect(requirements.extra.releasePolicy).toBe('sequencer-block')
    expect(requirements.extra.releasePolicyNote).toContain('sequencer block')
    expect(requirements.extra.releasePolicyNote).toContain('safe block')
    expect(requirements.extra.releasePolicyNote).toContain('reorg')
  })

  test('price is expressed in base units, not human units', () => {
    const halfPrice = buildPaymentRequirements(testConfig({ priceGusd: '0.5' }), resource)
    expect(halfPrice.maxAmountRequired).toBe('500000')
    expect(halfPrice.extra.priceDisplay).toBe('0.5')
  })

  test('resource url does not double up slashes', () => {
    const trailing = buildPaymentRequirements(
      testConfig({ baseUrl: 'https://insights.giwacard.test/' }),
      resource,
    )
    expect(trailing.resource).toBe('https://insights.giwacard.test/insights')
  })

  test('the whole body is JSON-serialisable (no bigints leak out)', () => {
    const body = buildPaymentRequiredBody(requirements, {
      code: 'payment_required',
      message: 'Payment required.',
    })
    expect(() => JSON.stringify(body)).not.toThrow()
    expect(body.x402Version).toBe(1)
    expect(body.reason).toBe('payment_required')
    expect(body.accepts).toHaveLength(1)
  })
})

describe('encode/decode X-PAYMENT', () => {
  const payment = {
    x402Version: X402_VERSION,
    scheme: GIWA_VAULT_CHARGE_SCHEME,
    network: config.network,
    payload: { transactionHash: txHash(0xabc), cardId: 12n },
  } as const

  test('round-trips through base64', () => {
    const decoded = decodePaymentHeader(encodePaymentHeader(payment), decodeOptions)
    expect(decoded.payload.transactionHash).toBe(txHash(0xabc))
    expect(decoded.payload.cardId).toBe(12n)
    expect(decoded.scheme).toBe(GIWA_VAULT_CHARGE_SCHEME)
  })

  test('accepts raw JSON, for curl-driven demos', () => {
    const decoded = decodePaymentHeader(
      JSON.stringify({ payload: { transactionHash: txHash(2), cardId: '3' } }),
      decodeOptions,
    )
    expect(decoded.payload.cardId).toBe(3n)
  })

  test('accepts unpadded base64url', () => {
    const standard = encodePaymentHeader(payment)
    const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(decodePaymentHeader(urlSafe, decodeOptions).payload.cardId).toBe(12n)
  })

  test('accepts a numeric cardId', () => {
    const decoded = decodePaymentHeader(
      b64({ payload: { transactionHash: txHash(2), cardId: 9 } }),
      decodeOptions,
    )
    expect(decoded.payload.cardId).toBe(9n)
  })

  test('accepts a cardId far beyond Number.MAX_SAFE_INTEGER as a string', () => {
    const huge = (2n ** 200n).toString()
    const decoded = decodePaymentHeader(
      b64({ payload: { transactionHash: txHash(2), cardId: huge } }),
      decodeOptions,
    )
    expect(decoded.payload.cardId).toBe(2n ** 200n)
  })

  test('lowercases the transaction hash so replay keys cannot be re-cased', () => {
    const mixed =
      '0xAABBCCDDEEFF00112233445566778899AABBCCDDEEFF001122334455667788AA' as const
    const decoded = decodePaymentHeader(
      b64({ payload: { transactionHash: mixed, cardId: '1' } }),
      decodeOptions,
    )
    expect(decoded.payload.transactionHash).toBe(mixed.toLowerCase() as `0x${string}`)
  })

  test('defaults an omitted version/scheme/network to this merchant', () => {
    const decoded = decodePaymentHeader(
      b64({ payload: { transactionHash: txHash(2), cardId: '1' } }),
      decodeOptions,
    )
    expect(decoded.x402Version).toBe(X402_VERSION)
    expect(decoded.scheme).toBe(GIWA_VAULT_CHARGE_SCHEME)
    expect(decoded.network).toBe(config.network)
  })
})

describe('decodePaymentHeader rejections', () => {
  const reject = (raw: string | undefined | null, code: PaymentErrorCode) => {
    try {
      decodePaymentHeader(raw, decodeOptions)
    } catch (error) {
      expect(error).toBeInstanceOf(PaymentError)
      expect((error as PaymentError).code).toBe(code)
      return error as PaymentError
    }
    throw new Error(`expected ${code} for ${JSON.stringify(raw)}`)
  }

  test('missing header', () => {
    reject(undefined, 'malformed_payment_header')
    reject(null, 'malformed_payment_header')
  })

  test('empty or whitespace header', () => {
    reject('', 'malformed_payment_header')
    reject('   ', 'malformed_payment_header')
  })

  test('not base64 and not JSON', () => {
    reject('this is not a payment!', 'malformed_payment_header')
  })

  test('valid base64 that is not JSON', () => {
    reject(Buffer.from('hello there', 'utf8').toString('base64'), 'malformed_payment_header')
  })

  test('JSON that is not an object', () => {
    reject(b64([1, 2, 3]), 'malformed_payment_header')
    reject(b64('a string'), 'malformed_payment_header')
  })

  test('missing payload', () => {
    reject(b64({ scheme: GIWA_VAULT_CHARGE_SCHEME }), 'malformed_payment_header')
  })

  test('missing or malformed transactionHash', () => {
    reject(b64({ payload: { cardId: '1' } }), 'malformed_payment_header')
    reject(b64({ payload: { transactionHash: 'nope', cardId: '1' } }), 'malformed_payment_header')
    reject(b64({ payload: { transactionHash: '0xabc', cardId: '1' } }), 'malformed_payment_header')
    reject(
      b64({ payload: { transactionHash: `${txHash(1)}ff`, cardId: '1' } }),
      'malformed_payment_header',
    )
  })

  test('missing or malformed cardId', () => {
    reject(b64({ payload: { transactionHash: txHash(1) } }), 'malformed_payment_header')
    reject(b64({ payload: { transactionHash: txHash(1), cardId: 'one' } }), 'malformed_payment_header')
    reject(b64({ payload: { transactionHash: txHash(1), cardId: -1 } }), 'malformed_payment_header')
    reject(b64({ payload: { transactionHash: txHash(1), cardId: 1.5 } }), 'malformed_payment_header')
  })

  test('cardId 0 is never a real card', () => {
    const error = reject(
      b64({ payload: { transactionHash: txHash(1), cardId: '0' } }),
      'malformed_payment_header',
    )
    expect(error.message).toContain('start at 1')
  })

  test('unsupported x402 version', () => {
    reject(
      b64({ x402Version: 2, payload: { transactionHash: txHash(1), cardId: '1' } }),
      'malformed_payment_header',
    )
  })

  test('unsupported scheme gets its own code, mentioning why not Permit2', () => {
    const error = reject(
      b64({ scheme: 'exact_evm', payload: { transactionHash: txHash(1), cardId: '1' } }),
      'unsupported_scheme',
    )
    expect(error.message).toContain('CardVault.charge')
    expect(error.message).toContain('Permit2')
  })

  test('unsupported network gets its own code', () => {
    const error = reject(
      b64({ network: 'base-sepolia', payload: { transactionHash: txHash(1), cardId: '1' } }),
      'unsupported_network',
    )
    expect(error.message).toContain('giwa-sepolia')
  })

  test('every rejection explains the expected shape', () => {
    const error = reject('garbage!!', 'malformed_payment_header')
    expect(error.message).toContain('transactionHash')
    expect(error.message).toContain('cardId')
  })
})

describe('PAYMENT-RESPONSE settlement receipt', () => {
  const settlement: SettlementResponse = {
    success: true,
    x402Version: X402_VERSION,
    scheme: GIWA_VAULT_CHARGE_SCHEME,
    network: config.network,
    transaction: txHash(1),
    payer: VAULT_OWNER,
    payee: MERCHANT_ADDRESS,
    vault: VAULT_ADDRESS,
    cardId: '1',
    amount: ONE_GUSD.toString(),
    released: '4000000',
    asset: TOKEN_ADDRESS,
    blockNumber: '1000',
    blockHash: txHash(9_999),
    logIndex: 0,
    releasePolicy: RELEASE_POLICY,
    settledAt: '2026-08-01T00:00:00.000Z',
  }

  test('round-trips', () => {
    const decoded = decodeSettlementHeader(encodeSettlementHeader(settlement))
    expect(decoded).toEqual(settlement)
  })

  test('rejects a header that is not a settlement receipt', () => {
    expect(() => decodeSettlementHeader(b64({ success: false }))).toThrow(PaymentError)
    expect(() => decodeSettlementHeader(b64({ success: true }))).toThrow(PaymentError)
  })
})

describe('httpStatusForPaymentError', () => {
  test('client-fixable failures are 402', () => {
    const clientCodes: PaymentErrorCode[] = [
      'payment_required',
      'malformed_payment_header',
      'unsupported_scheme',
      'unsupported_network',
      'transaction_not_found',
      'transaction_reverted',
      'no_charge_event',
      'wrong_vault',
      'wrong_merchant',
      'card_id_mismatch',
      'amount_below_price',
      'receipt_already_used',
    ]
    for (const code of clientCodes) {
      expect(httpStatusForPaymentError(code)).toBe(402)
    }
  })

  test('our own failure is a 503, so an agent does not pay twice for it', () => {
    expect(httpStatusForPaymentError('chain_unavailable')).toBe(503)
  })
})

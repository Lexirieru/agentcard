import { describe, expect, test } from 'bun:test'
import { getAddress, toEventSelector, type Hash } from 'viem'

import {
  CARD_CHARGED_SIGNATURE,
  CARD_CHARGED_TOPIC,
  InMemoryReceiptStore,
  MerchantFacilitator,
  cardChargedAbi,
  createViemReceiptReader,
  verifyCardCharge,
  type ChargeReceipt,
} from '../src/verify.js'
import { PaymentError, type PaymentErrorCode } from '../src/x402.js'

import {
  IMPOSTOR_VAULT,
  MERCHANT_ADDRESS,
  ONE_GUSD,
  OTHER_MERCHANT,
  StubReceiptReader,
  VAULT_ADDRESS,
  VAULT_OWNER,
  cardChargedLog,
  chargeReceipt,
  txHash,
  unrelatedLog,
} from './fixtures.js'

const BASE_INPUT = {
  transactionHash: txHash(1),
  cardId: 1n,
  vault: VAULT_ADDRESS,
  merchant: MERCHANT_ADDRESS,
  minAmount: ONE_GUSD,
} as const

/** Run a verification and assert it fails with a specific code. */
async function expectRejection(
  receipt: ChargeReceipt | null,
  code: PaymentErrorCode,
  input: Partial<typeof BASE_INPUT> = {},
): Promise<PaymentError> {
  const reader = new StubReceiptReader(receipt === null ? [] : [receipt])
  try {
    await verifyCardCharge(reader, { ...BASE_INPUT, ...input })
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentError)
    expect((error as PaymentError).code).toBe(code)
    return error as PaymentError
  }
  throw new Error(`expected verification to reject with ${code}, but it resolved`)
}

describe('CardCharged event definition', () => {
  test('mirrors the signature declared in CardVault.sol', () => {
    expect(CARD_CHARGED_SIGNATURE).toBe(
      'CardCharged(uint256,address,address,uint256,uint256)',
    )
    expect(CARD_CHARGED_TOPIC).toBe(toEventSelector(CARD_CHARGED_SIGNATURE))
  })

  test('keeps the exact parameter order and indexing of the contract', () => {
    const event = cardChargedAbi[0]
    expect(event.name).toBe('CardCharged')
    expect(event.inputs.map((input) => [input.name, input.type, input.indexed])).toEqual([
      ['cardId', 'uint256', true],
      ['vaultOwner', 'address', true],
      ['merchant', 'address', true],
      ['amount', 'uint256', false],
      ['released', 'uint256', false],
    ])
  })
})

describe('verifyCardCharge — happy path', () => {
  test('accepts a charge that pays this merchant for the claimed card', async () => {
    const reader = new StubReceiptReader([chargeReceipt()])
    const proof = await verifyCardCharge(reader, BASE_INPUT)

    expect(proof.transactionHash).toBe(txHash(1))
    expect(proof.cardId).toBe(1n)
    expect(proof.merchant).toBe(MERCHANT_ADDRESS)
    expect(proof.vaultOwner).toBe(VAULT_OWNER)
    expect(proof.vault).toBe(VAULT_ADDRESS)
    expect(proof.amount).toBe(ONE_GUSD)
    expect(proof.released).toBe(4_000_000n)
    expect(proof.blockNumber).toBe(1_000n)
    expect(proof.logIndex).toBe(0)
  })

  test('accepts an overpayment', async () => {
    const reader = new StubReceiptReader([
      chargeReceipt({ logs: [cardChargedLog({ amount: ONE_GUSD * 5n })] }),
    ])
    const proof = await verifyCardCharge(reader, BASE_INPUT)
    expect(proof.amount).toBe(ONE_GUSD * 5n)
  })

  test('accepts an exact payment (>= is inclusive)', async () => {
    const reader = new StubReceiptReader([
      chargeReceipt({ logs: [cardChargedLog({ amount: ONE_GUSD })] }),
    ])
    await expect(verifyCardCharge(reader, BASE_INPUT)).resolves.toBeDefined()
  })

  test('compares addresses case-insensitively', async () => {
    const reader = new StubReceiptReader([chargeReceipt()])
    const proof = await verifyCardCharge(reader, {
      ...BASE_INPUT,
      vault: VAULT_ADDRESS.toLowerCase() as `0x${string}`,
      merchant: MERCHANT_ADDRESS.toLowerCase() as `0x${string}`,
    })
    expect(proof.cardId).toBe(1n)
  })

  test('picks the matching event out of a receipt with several charges', async () => {
    const reader = new StubReceiptReader([
      chargeReceipt({
        logs: [
          unrelatedLog(),
          cardChargedLog({ cardId: 7n, merchant: OTHER_MERCHANT, logIndex: 1 }),
          cardChargedLog({ cardId: 1n, amount: ONE_GUSD * 2n, logIndex: 2 }),
        ],
      }),
    ])
    const proof = await verifyCardCharge(reader, BASE_INPUT)
    expect(proof.cardId).toBe(1n)
    expect(proof.amount).toBe(ONE_GUSD * 2n)
    expect(proof.logIndex).toBe(2)
  })
})

describe('verifyCardCharge — rejections', () => {
  test('rejects a hash the chain has never seen', async () => {
    const error = await expectRejection(null, 'transaction_not_found')
    expect(error.message).toContain(txHash(1))
  })

  test('rejects a reverted transaction', async () => {
    await expectRejection(chargeReceipt({ status: 'reverted' }), 'transaction_reverted')
  })

  test('rejects a receipt with no logs at all', async () => {
    await expectRejection(chargeReceipt({ logs: [] }), 'no_charge_event')
  })

  test('rejects a receipt whose logs are all unrelated events', async () => {
    await expectRejection(chargeReceipt({ logs: [unrelatedLog()] }), 'no_charge_event')
  })

  test('rejects a CardCharged emitted by a lookalike contract (impersonation)', async () => {
    // The attack: deploy a contract that emits a byte-identical CardCharged with
    // perfect merchant, cardId and amount. Nothing was actually paid — only the
    // emitting address distinguishes it from the real vault.
    const error = await expectRejection(
      chargeReceipt({
        logs: [
          cardChargedLog({
            address: IMPOSTOR_VAULT,
            cardId: 1n,
            merchant: MERCHANT_ADDRESS,
            amount: ONE_GUSD * 100n,
          }),
        ],
      }),
      'wrong_vault',
    )
    expect(error.message).toContain(VAULT_ADDRESS)
  })

  test('ignores a lookalike log even when the real vault also charged', async () => {
    const reader = new StubReceiptReader([
      chargeReceipt({
        logs: [
          cardChargedLog({
            address: IMPOSTOR_VAULT,
            cardId: 1n,
            amount: ONE_GUSD * 100n,
            logIndex: 0,
          }),
          cardChargedLog({ cardId: 1n, amount: ONE_GUSD, logIndex: 1 }),
        ],
      }),
    ])
    const proof = await verifyCardCharge(reader, BASE_INPUT)
    expect(proof.amount).toBe(ONE_GUSD)
    expect(proof.logIndex).toBe(1)
  })

  test('rejects a charge that paid a different merchant', async () => {
    const error = await expectRejection(
      chargeReceipt({ logs: [cardChargedLog({ merchant: OTHER_MERCHANT })] }),
      'wrong_merchant',
    )
    expect(error.message).toContain(MERCHANT_ADDRESS)
  })

  test('rejects a charge whose cardId is not the one claimed in X-PAYMENT', async () => {
    const error = await expectRejection(
      chargeReceipt({ logs: [cardChargedLog({ cardId: 42n })] }),
      'card_id_mismatch',
    )
    expect(error.message).toContain('42')
  })

  test('rejects a charge below the list price', async () => {
    const error = await expectRejection(
      chargeReceipt({ logs: [cardChargedLog({ amount: ONE_GUSD - 1n })] }),
      'amount_below_price',
    )
    expect(error.message).toContain('999999')
  })

  test('rejects a zero-amount charge', async () => {
    await expectRejection(
      chargeReceipt({ logs: [cardChargedLog({ amount: 0n })] }),
      'amount_below_price',
    )
  })

  test('maps a reader failure to chain_unavailable, not to a rejected payment', async () => {
    const reader = new StubReceiptReader()
    reader.failure = new Error('fetch failed')
    await expect(verifyCardCharge(reader, BASE_INPUT)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'chain_unavailable',
    })
  })

  test('drops a log with our topic0 but an undecodable body', async () => {
    // topic0 matches but the indexed topics are missing, so viem cannot decode.
    await expectRejection(
      chargeReceipt({
        logs: [{ address: VAULT_ADDRESS, topics: [CARD_CHARGED_TOPIC], data: '0x', logIndex: 0 }],
      }),
      'no_charge_event',
    )
  })
})

describe('InMemoryReceiptStore', () => {
  test('claims a hash once', () => {
    const store = new InMemoryReceiptStore()
    expect(store.claim(txHash(1))).toBe(true)
    expect(store.claim(txHash(1))).toBe(false)
    expect(store.has(txHash(1))).toBe(true)
    expect(store.size).toBe(1)
  })

  test('normalises case, so a re-cased hash cannot be replayed', () => {
    const store = new InMemoryReceiptStore()
    const lower = txHash(0xabc)
    expect(store.claim(lower)).toBe(true)
    expect(store.claim(lower.toUpperCase().replace('0X', '0x') as Hash)).toBe(false)
  })

  test('release makes a hash claimable again', () => {
    const store = new InMemoryReceiptStore()
    store.claim(txHash(1))
    store.release(txHash(1))
    expect(store.has(txHash(1))).toBe(false)
    expect(store.claim(txHash(1))).toBe(true)
  })

  test('evicts oldest entries past maxEntries', () => {
    const store = new InMemoryReceiptStore({ maxEntries: 2 })
    store.claim(txHash(1))
    store.claim(txHash(2))
    store.claim(txHash(3))
    expect(store.size).toBe(2)
    expect(store.has(txHash(1))).toBe(false)
    expect(store.has(txHash(3))).toBe(true)
  })

  test('rejects a nonsensical bound', () => {
    expect(() => new InMemoryReceiptStore({ maxEntries: 0 })).toThrow(TypeError)
  })
})

describe('MerchantFacilitator', () => {
  const build = (receipts: readonly ChargeReceipt[] = [chargeReceipt()]) => {
    const reader = new StubReceiptReader(receipts)
    const facilitator = new MerchantFacilitator({
      reader,
      vault: VAULT_ADDRESS,
      merchant: MERCHANT_ADDRESS,
    })
    return { reader, facilitator }
  }

  test('verifies and returns a proof', async () => {
    const { facilitator } = build()
    const proof = await facilitator.verify({
      transactionHash: txHash(1),
      cardId: 1n,
      minAmount: ONE_GUSD,
    })
    expect(proof.amount).toBe(ONE_GUSD)
    expect(facilitator.vault).toBe(VAULT_ADDRESS)
    expect(facilitator.merchant).toBe(MERCHANT_ADDRESS)
  })

  test('rejects a receipt that was already redeemed', async () => {
    const { facilitator, reader } = build()
    const input = { transactionHash: txHash(1), cardId: 1n, minAmount: ONE_GUSD }
    await facilitator.verify(input)

    await expect(facilitator.verify(input)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'receipt_already_used',
    })
    // The replay is refused without spending another RPC read.
    expect(reader.calls).toBe(1)
  })

  test('claims the hash before its first await, so concurrent replays lose', async () => {
    const { facilitator } = build()
    const input = { transactionHash: txHash(1), cardId: 1n, minAmount: ONE_GUSD }

    const results = await Promise.allSettled([
      facilitator.verify(input),
      facilitator.verify(input),
    ])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
  })

  test('releases the claim when verification fails, so an honest retry works', async () => {
    const { facilitator, reader } = build([])
    const input = { transactionHash: txHash(1), cardId: 1n, minAmount: ONE_GUSD }

    reader.failure = new Error('fetch failed')
    await expect(facilitator.verify(input)).rejects.toMatchObject({
      code: 'chain_unavailable',
    })
    expect(facilitator.store.has(txHash(1))).toBe(false)

    reader.failure = null
    reader.set(chargeReceipt())
    await expect(facilitator.verify(input)).resolves.toMatchObject({ cardId: 1n })
  })

  test('release() hands a consumed receipt back to the client', async () => {
    const { facilitator } = build()
    const input = { transactionHash: txHash(1), cardId: 1n, minAmount: ONE_GUSD }
    await facilitator.verify(input)
    expect(facilitator.store.has(txHash(1))).toBe(true)

    facilitator.release(txHash(1))
    await expect(facilitator.verify(input)).resolves.toMatchObject({ cardId: 1n })
  })

  test('a rejected payment does not burn the hash', async () => {
    const { facilitator } = build([
      chargeReceipt({ logs: [cardChargedLog({ merchant: OTHER_MERCHANT })] }),
    ])
    const input = { transactionHash: txHash(1), cardId: 1n, minAmount: ONE_GUSD }
    await expect(facilitator.verify(input)).rejects.toMatchObject({
      code: 'wrong_merchant',
    })
    expect(facilitator.store.size).toBe(0)
  })

  test('accepts an injected store, so the guard can be persisted later', async () => {
    const store = new InMemoryReceiptStore()
    store.claim(txHash(1))
    const facilitator = new MerchantFacilitator({
      reader: new StubReceiptReader([chargeReceipt()]),
      vault: VAULT_ADDRESS,
      merchant: MERCHANT_ADDRESS,
      store,
    })
    await expect(
      facilitator.verify({ transactionHash: txHash(1), cardId: 1n, minAmount: ONE_GUSD }),
    ).rejects.toMatchObject({ code: 'receipt_already_used' })
  })
})

describe('createViemReceiptReader', () => {
  test('maps a viem receipt onto the narrow reader shape', async () => {
    const reader = createViemReceiptReader({
      async getTransactionReceipt({ hash }) {
        return {
          transactionHash: hash,
          status: 'success' as const,
          blockNumber: 5n,
          blockHash: txHash(5),
          logs: [
            {
              address: getAddress(VAULT_ADDRESS),
              topics: cardChargedLog().topics,
              data: cardChargedLog().data,
              logIndex: 3,
            },
          ],
        }
      },
    })

    const receipt = await reader.getTransactionReceipt(txHash(1))
    expect(receipt?.blockNumber).toBe(5n)
    expect(receipt?.logs[0]?.logIndex).toBe(3)
  })

  test('maps TransactionReceiptNotFoundError to null rather than throwing', async () => {
    const notFound = Object.assign(new Error('not found'), {
      name: 'TransactionReceiptNotFoundError',
    })
    const reader = createViemReceiptReader({
      getTransactionReceipt: () => Promise.reject(notFound),
    })
    await expect(reader.getTransactionReceipt(txHash(1))).resolves.toBeNull()
  })

  test('propagates any other RPC failure', async () => {
    const reader = createViemReceiptReader({
      getTransactionReceipt: () => Promise.reject(new Error('429 Too Many Requests')),
    })
    await expect(reader.getTransactionReceipt(txHash(1))).rejects.toThrow('429')
  })
})

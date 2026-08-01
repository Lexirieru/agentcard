import { describe, expect, test } from 'bun:test'
import {
  encodeErrorResult,
  getAddress,
  toEventSelector,
  toFunctionSelector,
  type Hash,
} from 'viem'

import {
  CARD_CHARGED_SIGNATURE,
  CARD_CHARGED_TOPIC,
  InMemorySettlementStore,
  MerchantFacilitator,
  cardChargedAbi,
  cardVaultChargeAbi,
  classifyChargeFailure,
  createViemChargeSubmitter,
  verifyChargeReceipt,
  type ChargeProof,
  type ChargeReceipt,
  type ChargeRequest,
} from '../src/verify.js'
import { PaymentError, type PaymentErrorCode } from '../src/x402.js'

import {
  IMPOSTOR_VAULT,
  MERCHANT_ADDRESS,
  ONE_GUSD,
  OTHER_MERCHANT,
  StubChargeSubmitter,
  VAULT_ADDRESS,
  VAULT_OWNER,
  cardChargedLog,
  chargeReceipt,
  txHash,
  unrelatedLog,
} from './fixtures.js'

const BASE_INPUT = {
  cardId: 1n,
  vault: VAULT_ADDRESS,
  merchant: MERCHANT_ADDRESS,
  minAmount: ONE_GUSD,
} as const

const CHARGE_REQUEST: ChargeRequest = { cardId: 1n, amount: ONE_GUSD }

/** Run a verification and assert it fails with a specific code. */
function expectRejection(
  receipt: ChargeReceipt,
  code: PaymentErrorCode,
  input: Partial<typeof BASE_INPUT> = {},
): PaymentError {
  try {
    verifyChargeReceipt(receipt, { ...BASE_INPUT, ...input })
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentError)
    expect((error as PaymentError).code).toBe(code)
    return error as PaymentError
  }
  throw new Error(`expected verification to reject with ${code}, but it resolved`)
}

/**
 * A viem-shaped revert.
 *
 * viem wraps a decoded custom error in a `ContractFunctionRevertedError` several
 * `cause` levels down; the classifier walks that chain, so the fixture has to be
 * nested the same way to prove anything.
 */
function revertError(errorName: string, args: readonly unknown[] = []): Error {
  const inner = Object.assign(new Error(`reverted with ${errorName}`), {
    name: 'ContractFunctionRevertedError',
    data: { errorName, args },
  })
  const outer = Object.assign(new Error('execution reverted'), {
    name: 'ContractFunctionExecutionError',
    cause: inner,
  })
  return outer
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

describe('charge ABI', () => {
  test('the entrypoint selector matches the contract signature', () => {
    expect(toFunctionSelector('charge(uint256,uint256)')).toBe(
      toFunctionSelector('function charge(uint256 cardId, uint256 amount)'),
    )
  })

  test('every custom error selector matches its canonical signature', () => {
    // An argument-type typo (`uint256 status` instead of `uint8`) would still
    // compile and would still look right — and viem would silently fail to name
    // the revert, so every refusal would surface as a merchant-side 503.
    const canonical: Record<string, string> = {
      CardNotActive: 'CardNotActive(uint256,uint8)',
      CardExpired: 'CardExpired(uint256,uint64)',
      MerchantScopeMismatch: 'MerchantScopeMismatch(uint256,address,address)',
      ChargeExceedsCap: 'ChargeExceedsCap(uint256,uint256)',
      ZeroAmount: 'ZeroAmount()',
    }
    const errors = cardVaultChargeAbi.filter((entry) => entry.type === 'error')
    expect(errors).toHaveLength(Object.keys(canonical).length)

    for (const entry of errors) {
      const signature = canonical[entry.name]
      expect(signature).toBeDefined()
      const encoded = encodeErrorResult({
        abi: cardVaultChargeAbi,
        errorName: entry.name,
        // Placeholder args of the right arity; only the selector is compared.
        args: entry.inputs.map((input) =>
          input.type === 'address' ? VAULT_ADDRESS : 0n,
        ) as never,
      })
      expect(encoded.slice(0, 10)).toBe(toFunctionSelector(signature ?? ''))
    }
  })
})

describe('classifyChargeFailure — the vault refused', () => {
  const cases: readonly [string, readonly unknown[], PaymentErrorCode][] = [
    ['MerchantScopeMismatch', [1n, MERCHANT_ADDRESS, OTHER_MERCHANT], 'merchant_scope_mismatch'],
    ['CardNotActive', [1n, 2], 'card_already_used'],
    ['CardNotActive', [1n, 4], 'card_not_active'],
    ['CardNotActive', [1n, 0], 'card_not_active'],
    ['CardExpired', [1n, 1_800_000_000n], 'card_expired'],
    ['ChargeExceedsCap', [ONE_GUSD, 500_000n], 'card_cap_too_low'],
  ]

  for (const [errorName, args, code] of cases) {
    test(`${errorName}(${String(args[1])}) → ${code}`, () => {
      const mapped = classifyChargeFailure(revertError(errorName, args), CHARGE_REQUEST)
      expect(mapped).toBeInstanceOf(PaymentError)
      expect(mapped.code).toBe(code)
      expect(mapped.message).toContain('1')
    })
  }

  test('every vault refusal is something the buyer can act on (402)', () => {
    for (const [errorName, args] of cases) {
      const mapped = classifyChargeFailure(revertError(errorName, args), CHARGE_REQUEST)
      expect(mapped.code).not.toBe('settlement_failed')
    }
  })

  test('a revert we have no advice for is a merchant-side failure, not a 402', () => {
    // Better to say "we could not settle" than to tell a buyer to fix something
    // we cannot name.
    const mapped = classifyChargeFailure(revertError('SomeFutureError'), CHARGE_REQUEST)
    expect(mapped.code).toBe('settlement_failed')
  })
})

describe('classifyChargeFailure — the merchant failed', () => {
  const unfunded = [
    'insufficient funds for gas * price + value',
    'insufficient funds for intrinsic transaction cost',
    "sender doesn't have enough funds to send tx",
    'gas required exceeds allowance (0)',
  ]

  for (const message of unfunded) {
    test(`"${message.slice(0, 28)}…" is settlement_failed, and says so`, () => {
      const mapped = classifyChargeFailure(new Error(message), CHARGE_REQUEST)
      expect(mapped.code).toBe('settlement_failed')
      expect(mapped.message).toContain('no ETH for gas')
      expect(mapped.message).toContain('your card was not charged')
    })
  }

  test('finds the reason down a cause chain', () => {
    const nested = Object.assign(new Error('Transaction failed'), {
      cause: Object.assign(new Error('rpc error'), {
        details: 'insufficient funds for gas',
      }),
    })
    expect(classifyChargeFailure(nested, CHARGE_REQUEST).code).toBe('settlement_failed')
  })

  test('an unrecognised failure is settlement_failed, never a 402', () => {
    const mapped = classifyChargeFailure(new Error('fetch failed'), CHARGE_REQUEST)
    expect(mapped.code).toBe('settlement_failed')
  })

  test('an already-classified PaymentError passes straight through', () => {
    const original = new PaymentError('card_expired', 'nope')
    expect(classifyChargeFailure(original, CHARGE_REQUEST)).toBe(original)
  })

  test('a cyclic cause chain terminates', () => {
    const a: { cause?: unknown; message: string } = { message: 'a' }
    const b = { message: 'b', cause: a }
    a.cause = b
    expect(classifyChargeFailure(a, CHARGE_REQUEST).code).toBe('settlement_failed')
  })
})

describe('verifyChargeReceipt — happy path', () => {
  test('accepts a settlement that paid this merchant for the charged card', () => {
    const proof = verifyChargeReceipt(chargeReceipt(), BASE_INPUT)

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

  test('accepts a charge above the price', () => {
    const proof = verifyChargeReceipt(
      chargeReceipt({ logs: [cardChargedLog({ amount: ONE_GUSD * 5n })] }),
      BASE_INPUT,
    )
    expect(proof.amount).toBe(ONE_GUSD * 5n)
  })

  test('accepts an exact payment (>= is inclusive)', () => {
    expect(
      verifyChargeReceipt(
        chargeReceipt({ logs: [cardChargedLog({ amount: ONE_GUSD })] }),
        BASE_INPUT,
      ).amount,
    ).toBe(ONE_GUSD)
  })

  test('compares addresses case-insensitively', () => {
    const proof = verifyChargeReceipt(chargeReceipt(), {
      ...BASE_INPUT,
      vault: VAULT_ADDRESS.toLowerCase() as `0x${string}`,
      merchant: MERCHANT_ADDRESS.toLowerCase() as `0x${string}`,
    })
    expect(proof.cardId).toBe(1n)
  })

  test('picks the matching event out of a receipt with several charges', () => {
    const proof = verifyChargeReceipt(
      chargeReceipt({
        logs: [
          unrelatedLog(),
          cardChargedLog({ cardId: 7n, merchant: OTHER_MERCHANT, logIndex: 1 }),
          cardChargedLog({ cardId: 1n, amount: ONE_GUSD * 2n, logIndex: 2 }),
        ],
      }),
      BASE_INPUT,
    )
    expect(proof.cardId).toBe(1n)
    expect(proof.amount).toBe(ONE_GUSD * 2n)
    expect(proof.logIndex).toBe(2)
  })
})

describe('verifyChargeReceipt — rejections', () => {
  test('rejects a settlement transaction that reverted after inclusion', () => {
    expectRejection(chargeReceipt({ status: 'reverted' }), 'settlement_failed')
  })

  test('rejects a receipt with no logs at all', () => {
    expectRejection(chargeReceipt({ logs: [] }), 'no_charge_event')
  })

  test('rejects a receipt whose logs are all unrelated events', () => {
    expectRejection(chargeReceipt({ logs: [unrelatedLog()] }), 'no_charge_event')
  })

  test('rejects a CardCharged emitted by a lookalike contract (impersonation)', () => {
    // Under merchant-pull this is no longer a hostile client — we chose the
    // address we called. It is now the guard against a misconfigured
    // CARD_VAULT_ADDRESS, or a vault that re-emits through an inner contract:
    // the topics prove nothing about who emitted them, only the address does.
    const error = expectRejection(
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

  test('ignores a lookalike log even when the real vault also charged', () => {
    const proof = verifyChargeReceipt(
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
      BASE_INPUT,
    )
    expect(proof.amount).toBe(ONE_GUSD)
    expect(proof.logIndex).toBe(1)
  })

  test('rejects a charge that paid a different merchant', () => {
    const error = expectRejection(
      chargeReceipt({ logs: [cardChargedLog({ merchant: OTHER_MERCHANT })] }),
      'wrong_merchant',
    )
    expect(error.message).toContain(MERCHANT_ADDRESS)
  })

  test('rejects a charge whose cardId is not the one we charged', () => {
    const error = expectRejection(
      chargeReceipt({ logs: [cardChargedLog({ cardId: 42n })] }),
      'card_id_mismatch',
    )
    expect(error.message).toContain('42')
  })

  test('rejects a charge below the list price', () => {
    const error = expectRejection(
      chargeReceipt({ logs: [cardChargedLog({ amount: ONE_GUSD - 1n })] }),
      'amount_below_price',
    )
    expect(error.message).toContain('999999')
  })

  test('rejects a zero-amount charge', () => {
    expectRejection(chargeReceipt({ logs: [cardChargedLog({ amount: 0n })] }), 'amount_below_price')
  })

  test('drops a log with our topic0 but an undecodable body', () => {
    // topic0 matches but the indexed topics are missing, so viem cannot decode.
    expectRejection(
      chargeReceipt({
        logs: [{ address: VAULT_ADDRESS, topics: [CARD_CHARGED_TOPIC], data: '0x', logIndex: 0 }],
      }),
      'no_charge_event',
    )
  })
})

describe('InMemorySettlementStore', () => {
  const proof = (cardId: bigint): ChargeProof => ({
    transactionHash: txHash(Number(cardId)),
    blockNumber: 1n,
    blockHash: txHash(9),
    logIndex: 0,
    vault: VAULT_ADDRESS,
    cardId,
    vaultOwner: VAULT_OWNER,
    merchant: MERCHANT_ADDRESS,
    amount: ONE_GUSD,
    released: 0n,
  })

  test('claims a card once', () => {
    const store = new InMemorySettlementStore()
    expect(store.claim(1n)).toBe(true)
    expect(store.claim(1n)).toBe(false)
    expect(store.has(1n)).toBe(true)
    expect(store.size).toBe(1)
  })

  test('release makes a card claimable again', () => {
    const store = new InMemorySettlementStore()
    store.claim(1n)
    store.release(1n)
    expect(store.has(1n)).toBe(false)
    expect(store.claim(1n)).toBe(true)
  })

  test('an undelivered settlement can be taken exactly once', () => {
    const store = new InMemorySettlementStore()
    store.claim(1n)
    expect(store.takeUndelivered(1n)).toBeNull()

    store.record(1n, proof(1n))
    expect(store.takeUndelivered(1n)?.transactionHash).toBe(txHash(1))
    // Taking is what makes a burst of retries ship one report, not five.
    expect(store.takeUndelivered(1n)).toBeNull()
    expect(store.has(1n)).toBe(true)
    expect(store.claim(1n)).toBe(false)
  })

  test('a consumed card is never undelivered again', () => {
    const store = new InMemorySettlementStore()
    store.claim(1n)
    store.consume(1n)
    expect(store.takeUndelivered(1n)).toBeNull()
    expect(store.claim(1n)).toBe(false)
  })

  test('evicts oldest entries past maxEntries', () => {
    const store = new InMemorySettlementStore({ maxEntries: 2 })
    store.claim(1n)
    store.claim(2n)
    store.claim(3n)
    expect(store.size).toBe(2)
    expect(store.has(1n)).toBe(false)
    expect(store.has(3n)).toBe(true)
  })

  test('rejects a nonsensical bound', () => {
    expect(() => new InMemorySettlementStore({ maxEntries: 0 })).toThrow(TypeError)
  })
})

describe('MerchantFacilitator', () => {
  const build = (submitter = new StubChargeSubmitter()) => {
    const facilitator = new MerchantFacilitator({
      submitter,
      vault: VAULT_ADDRESS,
      merchant: MERCHANT_ADDRESS,
    })
    return { submitter, facilitator }
  }

  test('charges the card and returns a proof of its own transaction', async () => {
    const { facilitator, submitter } = build()
    const proof = await facilitator.settle({ cardId: 1n, amount: ONE_GUSD })

    expect(submitter.calls).toEqual([{ cardId: 1n, amount: ONE_GUSD }])
    expect(proof.amount).toBe(ONE_GUSD)
    expect(proof.transactionHash).toBe(txHash(1))
    expect(facilitator.vault).toBe(VAULT_ADDRESS)
    expect(facilitator.merchant).toBe(MERCHANT_ADDRESS)
  })

  test('refuses a card it already settled, without charging again', async () => {
    const { facilitator, submitter } = build()
    const input = { cardId: 1n, amount: ONE_GUSD }
    await facilitator.settle(input)

    await expect(facilitator.settle(input)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'card_already_settled',
    })
    expect(submitter.calls).toHaveLength(1)
  })

  test('claims the card before its first await, so concurrent replays lose', async () => {
    const { facilitator, submitter } = build()
    const input = { cardId: 1n, amount: ONE_GUSD }

    const results = await Promise.allSettled([
      facilitator.settle(input),
      facilitator.settle(input),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(submitter.calls).toHaveLength(1)
  })

  test('releases the claim when the charge never happened, so a retry works', async () => {
    const { facilitator, submitter } = build()
    const input = { cardId: 1n, amount: ONE_GUSD }

    submitter.failure = new Error('insufficient funds for gas')
    await expect(facilitator.settle(input)).rejects.toMatchObject({
      code: 'settlement_failed',
    })
    expect(facilitator.store.has(1n)).toBe(false)

    submitter.failure = null
    await expect(facilitator.settle(input)).resolves.toMatchObject({ cardId: 1n })
  })

  test('a vault refusal does not burn the card id', async () => {
    const { facilitator, submitter } = build()
    submitter.refuseWith = 'merchant_scope_mismatch'
    await expect(facilitator.settle({ cardId: 1n, amount: ONE_GUSD })).rejects.toMatchObject({
      code: 'merchant_scope_mismatch',
    })
    expect(facilitator.store.size).toBe(0)
  })

  test('a mined transaction that fails verification keeps the card claimed', async () => {
    // The money may well have moved. Charging a second card would be the one
    // response that is definitely wrong.
    const submitter = new StubChargeSubmitter().set(
      1n,
      chargeReceipt({ logs: [cardChargedLog({ merchant: OTHER_MERCHANT })] }),
    )
    const { facilitator } = build(submitter)

    await expect(facilitator.settle({ cardId: 1n, amount: ONE_GUSD })).rejects.toMatchObject({
      code: 'wrong_merchant',
    })
    expect(facilitator.store.has(1n)).toBe(true)
  })

  test('settling leaves nothing to collect: the caller already holds the proof', async () => {
    const { facilitator } = build()
    await facilitator.settle({ cardId: 1n, amount: ONE_GUSD })
    expect(facilitator.takeSettled(1n)).toBeNull()
  })

  test('a returned settlement can be collected exactly once', async () => {
    const { facilitator } = build()
    const proof = await facilitator.settle({ cardId: 1n, amount: ONE_GUSD })

    facilitator.returnUndelivered(1n, proof)
    expect(facilitator.takeSettled(1n)?.cardId).toBe(1n)
    expect(facilitator.takeSettled(1n)).toBeNull()
  })

  test('accepts an injected store, so the guard can be persisted later', async () => {
    const store = new InMemorySettlementStore()
    store.claim(1n)
    const facilitator = new MerchantFacilitator({
      submitter: new StubChargeSubmitter(),
      vault: VAULT_ADDRESS,
      merchant: MERCHANT_ADDRESS,
      store,
    })
    await expect(facilitator.settle({ cardId: 1n, amount: ONE_GUSD })).rejects.toMatchObject({
      code: 'card_already_settled',
    })
  })
})

describe('createViemChargeSubmitter', () => {
  const wallet = (hash: Hash | Error) => ({
    writeContract: async (args: { functionName: string; args: readonly unknown[] }) => {
      calls.push(args)
      if (hash instanceof Error) throw hash
      return hash
    },
  })
  let calls: { functionName: string; args: readonly unknown[] }[] = []

  test('calls charge(cardId, amount) on the configured vault and maps the receipt', async () => {
    calls = []
    const submitter = createViemChargeSubmitter({
      wallet: wallet(txHash(3)),
      receipts: {
        async waitForTransactionReceipt({ hash }) {
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
      },
      vault: VAULT_ADDRESS,
    })

    const receipt = await submitter.submitCharge({ cardId: 9n, amount: ONE_GUSD })
    expect(calls[0]?.functionName).toBe('charge')
    expect(calls[0]?.args).toEqual([9n, ONE_GUSD])
    expect(receipt.transactionHash).toBe(txHash(3))
    expect(receipt.blockNumber).toBe(5n)
    expect(receipt.logs[0]?.logIndex).toBe(3)
  })

  test('classifies a revert instead of leaking a viem error', async () => {
    calls = []
    const submitter = createViemChargeSubmitter({
      wallet: wallet(revertError('MerchantScopeMismatch', [1n, MERCHANT_ADDRESS, OTHER_MERCHANT])),
      receipts: { waitForTransactionReceipt: () => Promise.reject(new Error('unused')) },
      vault: VAULT_ADDRESS,
    })

    await expect(submitter.submitCharge(CHARGE_REQUEST)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'merchant_scope_mismatch',
    })
  })

  test('a receipt we cannot read is chain_unavailable, and names the tx', async () => {
    calls = []
    const submitter = createViemChargeSubmitter({
      wallet: wallet(txHash(3)),
      receipts: { waitForTransactionReceipt: () => Promise.reject(new Error('timeout')) },
      vault: VAULT_ADDRESS,
    })

    await expect(submitter.submitCharge(CHARGE_REQUEST)).rejects.toMatchObject({
      name: 'PaymentError',
      code: 'chain_unavailable',
    })
  })
})

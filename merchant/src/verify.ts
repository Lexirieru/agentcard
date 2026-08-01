/**
 * The merchant's built-in x402 facilitator — **read-only**.
 *
 * It verifies that a `CardVault.charge` transaction really paid this merchant,
 * by reading the transaction receipt and decoding the `CardCharged` event. It
 * never submits a transaction and never holds a funded key (KTD-6/KTD-9), which
 * is the whole reason the scheme is built around a vault charge rather than a
 * Permit2 pull: the payment is already onchain by the time we look.
 *
 * ## What "verified" means here
 *
 * A receipt is accepted only when **all** of the following hold:
 *
 * 1. the transaction exists and succeeded;
 * 2. it contains a `CardCharged` log emitted **by the configured vault address**
 *    — this is the impersonation guard. Anyone can deploy a lookalike contract
 *    that emits a byte-identical event; the topics prove nothing about *who*
 *    emitted them, only the log's `address` does. So we filter by address
 *    *before* we believe a single decoded field;
 * 3. that event's `merchant` is this merchant;
 * 4. its `cardId` is the one the client claimed in `X-PAYMENT` — otherwise a
 *    client could point at somebody else's charge transaction;
 * 5. its `amount` is at least the list price;
 * 6. the transaction hash has not already bought a report (replay guard).
 *
 * ## KTD-5 release policy
 *
 * We read the receipt at the **sequencer** block (`latest`) and release the
 * product immediately. We do **not** wait for the safe block. On an OP Stack
 * testnet a sequencer block can be reorged, so in principle a report could be
 * released against a charge that later disappears. That risk is accepted
 * consciously: waiting for `safe` takes minutes and would destroy the point of
 * an agent paying for an API call in-line. A merchant selling something
 * irreversible should wait for `safe` instead.
 */

import {
  decodeEventLog,
  toEventSelector,
  type Abi,
  type Address,
  type Hash,
  type Hex,
} from 'viem'

import { PaymentError } from './x402.js'

/* -------------------------------------------------------------------------- */
/* The event                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `CardCharged` exactly as declared in `smartcontracts/src/CardVault.sol`.
 *
 * Parameter order and indexing are load-bearing: `cardId`, `vaultOwner` and
 * `merchant` are indexed (topics 1..3), `amount` and `released` are in the data
 * blob. Getting the order wrong would decode a valid payment into nonsense.
 */
export const cardChargedAbi = [
  {
    type: 'event',
    name: 'CardCharged',
    anonymous: false,
    inputs: [
      { name: 'cardId', type: 'uint256', indexed: true, internalType: 'uint256' },
      { name: 'vaultOwner', type: 'address', indexed: true, internalType: 'address' },
      { name: 'merchant', type: 'address', indexed: true, internalType: 'address' },
      { name: 'amount', type: 'uint256', indexed: false, internalType: 'uint256' },
      { name: 'released', type: 'uint256', indexed: false, internalType: 'uint256' },
    ],
  },
] as const satisfies Abi

/** Canonical signature of `CardCharged`, used to compute topic0. */
export const CARD_CHARGED_SIGNATURE =
  'CardCharged(uint256,address,address,uint256,uint256)' as const

/** `keccak256` of {@link CARD_CHARGED_SIGNATURE}: the log's topic0. */
export const CARD_CHARGED_TOPIC: Hex = toEventSelector(CARD_CHARGED_SIGNATURE)

/* -------------------------------------------------------------------------- */
/* Reader interface                                                           */
/* -------------------------------------------------------------------------- */

/** One log entry, narrowed to the fields verification actually reads. */
export interface ChargeLog {
  /** Contract that emitted the log. The impersonation guard turns on this. */
  readonly address: Address
  readonly topics: readonly Hex[]
  readonly data: Hex
  /** Index of the log within its block. */
  readonly logIndex: number
}

/** A transaction receipt, narrowed to what verification reads. */
export interface ChargeReceipt {
  readonly transactionHash: Hash
  readonly status: 'success' | 'reverted'
  readonly blockNumber: bigint
  readonly blockHash: Hash
  readonly logs: readonly ChargeLog[]
}

/**
 * The only chain access the facilitator needs.
 *
 * Injected so the test suite never touches a live RPC, and so the facilitator
 * cannot accidentally grow a write path: there is nothing here to write with.
 */
export interface ChargeReceiptReader {
  /** Resolve a receipt, or `null` when the chain has never seen the hash. */
  getTransactionReceipt(hash: Hash): Promise<ChargeReceipt | null>
}

/** The subset of a viem public client {@link createViemReceiptReader} needs. */
export interface ViemReceiptClient {
  getTransactionReceipt(args: { hash: Hash }): Promise<{
    transactionHash: Hash
    status: 'success' | 'reverted'
    blockNumber: bigint
    blockHash: Hash
    logs: readonly {
      address: Address
      topics: readonly Hex[]
      data: Hex
      logIndex: number
    }[]
  }>
}

/** viem's "no such receipt" error, matched by name to avoid a class import. */
function isReceiptNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'TransactionReceiptNotFoundError'
  )
}

/**
 * Adapt a viem public client to {@link ChargeReceiptReader}.
 *
 * viem throws `TransactionReceiptNotFoundError` for an unknown hash; a pending
 * or non-existent transaction is an answer, not a failure, so it maps to `null`.
 */
export function createViemReceiptReader(client: ViemReceiptClient): ChargeReceiptReader {
  return {
    async getTransactionReceipt(hash) {
      try {
        const receipt = await client.getTransactionReceipt({ hash })
        return {
          transactionHash: receipt.transactionHash,
          status: receipt.status,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          logs: receipt.logs.map((log) => ({
            address: log.address,
            topics: log.topics,
            data: log.data,
            logIndex: log.logIndex,
          })),
        }
      } catch (error) {
        if (isReceiptNotFound(error)) return null
        throw error
      }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Replay store                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Tracks which transaction hashes have already bought a report.
 *
 * `claim` must be atomic with respect to the event loop — it is called before
 * the first `await` of a verification, so two concurrent requests carrying the
 * same receipt cannot both pass.
 */
export interface ReceiptStore {
  /** Reserve `hash`. Returns `false` if it was already reserved or consumed. */
  claim(hash: Hash): boolean
  /** Undo a reservation whose verification failed, so an honest retry works. */
  release(hash: Hash): void
  /** Whether `hash` is currently reserved or consumed. */
  has(hash: Hash): boolean
  /** Number of tracked hashes. */
  readonly size: number
}

/**
 * In-memory {@link ReceiptStore} with bounded FIFO eviction.
 *
 * A real merchant would persist this. For the demo an in-process Map is right,
 * with one honest caveat: once `maxEntries` is exceeded the oldest hashes are
 * evicted and could in principle be replayed. That window is bounded by
 * `maxEntries` requests, and `CardVault` independently flips a charged card to
 * `Used`, so a replayed receipt can never move money a second time — only serve
 * a second copy of a report. Restarting the process has the same effect.
 */
export class InMemoryReceiptStore implements ReceiptStore {
  readonly #hashes = new Set<string>()
  readonly #maxEntries: number

  constructor(options: { maxEntries?: number } = {}) {
    const maxEntries = options.maxEntries ?? 100_000
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError(
        `InMemoryReceiptStore: maxEntries must be a positive integer, got ${String(maxEntries)}`,
      )
    }
    this.#maxEntries = maxEntries
  }

  claim(hash: Hash): boolean {
    const key = hash.toLowerCase()
    if (this.#hashes.has(key)) return false
    this.#hashes.add(key)
    // Set iteration order is insertion order, so the first key is the oldest.
    while (this.#hashes.size > this.#maxEntries) {
      const oldest = this.#hashes.values().next()
      if (oldest.done === true) break
      this.#hashes.delete(oldest.value)
    }
    return true
  }

  release(hash: Hash): void {
    this.#hashes.delete(hash.toLowerCase())
  }

  has(hash: Hash): boolean {
    return this.#hashes.has(hash.toLowerCase())
  }

  get size(): number {
    return this.#hashes.size
  }
}

/* -------------------------------------------------------------------------- */
/* Verification                                                               */
/* -------------------------------------------------------------------------- */

/** A decoded, verified `CardCharged` event plus where it was found. */
export interface ChargeProof {
  readonly transactionHash: Hash
  readonly blockNumber: bigint
  readonly blockHash: Hash
  readonly logIndex: number
  /** Contract that emitted it — always the configured vault. */
  readonly vault: Address
  readonly cardId: bigint
  /** Vault owner whose escrow funded the charge. */
  readonly vaultOwner: Address
  readonly merchant: Address
  readonly amount: bigint
  readonly released: bigint
}

/** Everything {@link verifyCardCharge} must be told to judge a payment. */
export interface VerifyCardChargeInput {
  readonly transactionHash: Hash
  readonly cardId: bigint
  /** The one contract whose `CardCharged` events count. */
  readonly vault: Address
  /** The address that must have been paid. */
  readonly merchant: Address
  /** List price, in token base units. */
  readonly minAmount: bigint
}

/** Case-insensitive address equality. Addresses are hex, not text. */
function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

interface DecodedCharge {
  readonly log: ChargeLog
  readonly cardId: bigint
  readonly vaultOwner: Address
  readonly merchant: Address
  readonly amount: bigint
  readonly released: bigint
}

/**
 * Decode a log as `CardCharged`, or return `null` if it is not one.
 *
 * A log with our topic0 but a body we cannot decode is a malformed impostor, not
 * a payment, so it is dropped rather than thrown on.
 */
function decodeCharge(log: ChargeLog): DecodedCharge | null {
  if (log.topics.length === 0 || log.topics[0] !== CARD_CHARGED_TOPIC) return null
  try {
    const decoded = decodeEventLog({
      abi: cardChargedAbi,
      eventName: 'CardCharged',
      data: log.data,
      // Non-empty by the guard above; viem wants the tuple form.
      topics: log.topics as [Hex, ...Hex[]],
    })
    return {
      log,
      cardId: decoded.args.cardId,
      vaultOwner: decoded.args.vaultOwner,
      merchant: decoded.args.merchant,
      amount: decoded.args.amount,
      released: decoded.args.released,
    }
  } catch {
    return null
  }
}

/**
 * Verify that `transactionHash` contains a `CardCharged` event paying this
 * merchant at least `minAmount` for `cardId`, emitted by `vault`.
 *
 * Stateless: replay protection lives in {@link MerchantFacilitator}, so this
 * function can be called safely from a test or a dry run.
 *
 * @throws {PaymentError} with the specific reason the receipt was rejected.
 */
export async function verifyCardCharge(
  reader: ChargeReceiptReader,
  input: VerifyCardChargeInput,
): Promise<ChargeProof> {
  let receipt: ChargeReceipt | null
  try {
    receipt = await reader.getTransactionReceipt(input.transactionHash)
  } catch (cause) {
    throw new PaymentError(
      'chain_unavailable',
      `Could not read the GIWA Sepolia receipt for ${input.transactionHash}. ` +
        'The merchant could not verify payment; this is a merchant-side failure, not a rejected payment.',
      { cause },
    )
  }

  if (receipt === null) {
    throw new PaymentError(
      'transaction_not_found',
      `No receipt for transaction ${input.transactionHash} on the sequencer chain. ` +
        'Submit CardVault.charge first, wait for inclusion, then retry with the resulting hash.',
    )
  }

  if (receipt.status !== 'success') {
    throw new PaymentError(
      'transaction_reverted',
      `Transaction ${input.transactionHash} reverted, so no payment was made.`,
    )
  }

  // Impersonation guard: split by emitter *before* trusting any decoded field.
  // A lookalike contract can emit a byte-identical CardCharged; only the log's
  // `address` distinguishes the real vault from the forgery.
  const fromVault: DecodedCharge[] = []
  let sawForeignChargeEvent = false
  for (const log of receipt.logs) {
    const decoded = decodeCharge(log)
    if (decoded === null) continue
    if (sameAddress(log.address, input.vault)) {
      fromVault.push(decoded)
    } else {
      sawForeignChargeEvent = true
    }
  }

  if (fromVault.length === 0) {
    if (sawForeignChargeEvent) {
      throw new PaymentError(
        'wrong_vault',
        `Transaction ${input.transactionHash} emits CardCharged, but not from the vault this ` +
          `merchant trusts (${input.vault}). A contract that merely emits the same event shape ` +
          'has not moved any gUSD.',
      )
    }
    throw new PaymentError(
      'no_charge_event',
      `Transaction ${input.transactionHash} contains no CardCharged event from ${input.vault}.`,
    )
  }

  const toMerchant = fromVault.filter((charge) => sameAddress(charge.merchant, input.merchant))
  if (toMerchant.length === 0) {
    throw new PaymentError(
      'wrong_merchant',
      `Transaction ${input.transactionHash} charged a card, but paid ` +
        `${fromVault.map((charge) => charge.merchant).join(', ')} rather than this merchant (${input.merchant}).`,
    )
  }

  const forCard = toMerchant.filter((charge) => charge.cardId === input.cardId)
  if (forCard.length === 0) {
    throw new PaymentError(
      'card_id_mismatch',
      `X-PAYMENT claims card ${input.cardId}, but transaction ${input.transactionHash} charged ` +
        `card ${toMerchant.map((charge) => charge.cardId.toString()).join(', ')}.`,
    )
  }

  const paid = forCard.find((charge) => charge.amount >= input.minAmount)
  if (paid === undefined) {
    const best = forCard.reduce(
      (max, charge) => (charge.amount > max ? charge.amount : max),
      0n,
    )
    throw new PaymentError(
      'amount_below_price',
      `Card ${input.cardId} was charged ${best} base units, below the ${input.minAmount} required.`,
    )
  }

  return {
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    logIndex: paid.log.logIndex,
    vault: input.vault,
    cardId: paid.cardId,
    vaultOwner: paid.vaultOwner,
    merchant: paid.merchant,
    amount: paid.amount,
    released: paid.released,
  }
}

/* -------------------------------------------------------------------------- */
/* Facilitator                                                                */
/* -------------------------------------------------------------------------- */

/** Construction options for {@link MerchantFacilitator}. */
export interface MerchantFacilitatorOptions {
  /** Chain access. Read-only by construction. */
  readonly reader: ChargeReceiptReader
  /** The one contract whose `CardCharged` events count. */
  readonly vault: Address
  /** The address that must have been paid. */
  readonly merchant: Address
  /** Replay store. Defaults to a fresh {@link InMemoryReceiptStore}. */
  readonly store?: ReceiptStore
}

/** A payment to verify: what the client claimed, and what it must be worth. */
export interface FacilitatorVerifyInput {
  readonly transactionHash: Hash
  readonly cardId: bigint
  /** List price of the resource being bought, in token base units. */
  readonly minAmount: bigint
}

/**
 * Stateful wrapper around {@link verifyCardCharge} that also enforces
 * single-use receipts.
 *
 * Holds no key and signs nothing; the only state it owns is the set of consumed
 * transaction hashes.
 */
export class MerchantFacilitator {
  readonly #reader: ChargeReceiptReader
  readonly #vault: Address
  readonly #merchant: Address
  readonly #store: ReceiptStore

  constructor(options: MerchantFacilitatorOptions) {
    this.#reader = options.reader
    this.#vault = options.vault
    this.#merchant = options.merchant
    this.#store = options.store ?? new InMemoryReceiptStore()
  }

  /** The vault whose events this facilitator trusts. */
  get vault(): Address {
    return this.#vault
  }

  /** The address this facilitator requires to be paid. */
  get merchant(): Address {
    return this.#merchant
  }

  /** The replay store, exposed for operational inspection. */
  get store(): ReceiptStore {
    return this.#store
  }

  /**
   * Verify a payment and consume its receipt.
   *
   * The hash is claimed *synchronously*, before the first `await`, so two
   * concurrent requests carrying the same receipt cannot both be served. A
   * verification that fails releases the claim again, so a client whose request
   * lost to a transient RPC error can retry with the same honest receipt.
   *
   * @throws {PaymentError} `receipt_already_used` when the hash was already
   * spent, or whatever {@link verifyCardCharge} rejects it with.
   */
  async verify(input: FacilitatorVerifyInput): Promise<ChargeProof> {
    if (!this.#store.claim(input.transactionHash)) {
      throw new PaymentError(
        'receipt_already_used',
        `Transaction ${input.transactionHash} has already been redeemed. ` +
          'Each charge buys exactly one report; submit a new CardVault.charge for another.',
      )
    }

    try {
      return await verifyCardCharge(this.#reader, {
        transactionHash: input.transactionHash,
        cardId: input.cardId,
        vault: this.#vault,
        merchant: this.#merchant,
        minAmount: input.minAmount,
      })
    } catch (error) {
      this.#store.release(input.transactionHash)
      throw error
    }
  }

  /**
   * Release a consumed receipt.
   *
   * Called when the merchant verified a payment but then failed to produce the
   * product: the client paid, so it must be able to retry with the same receipt.
   */
  release(transactionHash: Hash): void {
    this.#store.release(transactionHash)
  }
}

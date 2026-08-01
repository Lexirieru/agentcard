/**
 * The merchant's built-in x402 facilitator — it **settles**, then verifies.
 *
 * `CardVault.charge` requires `msg.sender == card.merchantScope` and pays
 * `msg.sender`, so the merchant is the party that runs the card (KTD-9). The
 * facilitator therefore does two things on a paid request:
 *
 * 1. submits `CardVault.charge(cardId, price)` from the merchant's own funded
 *    key and waits for the receipt;
 * 2. verifies the `CardCharged` event on **its own** transaction.
 *
 * Step 2 is not ceremony. "The RPC did not throw" is not the same claim as "the
 * vault I trust moved the amount I asked for, from the card I was presented, to
 * me". The checks below are the ones a read-only facilitator would run — this
 * module used to *be* a read-only facilitator, checking a hash a stranger handed
 * it — and they are all still meaningful when the transaction is our own,
 * because the vault address is configuration and the amount is arithmetic.
 *
 * ## What "verified" means here
 *
 * A settlement is accepted only when **all** of the following hold:
 *
 * 1. our charge transaction succeeded;
 * 2. it contains a `CardCharged` log emitted **by the configured vault address**
 *    — the impersonation guard. Anyone can deploy a lookalike contract that
 *    emits a byte-identical event; the topics prove nothing about *who* emitted
 *    them, only the log's `address` does. So we filter by address *before* we
 *    believe a single decoded field. Under merchant-pull this catches a
 *    misconfigured `CARD_VAULT_ADDRESS` (or a vault that re-emits through an
 *    inner contract) rather than a hostile client;
 * 3. that event's `merchant` is this merchant;
 * 4. its `cardId` is the card we were presented and charged;
 * 5. its `amount` is at least the list price;
 * 6. the cardId has not already bought a report (replay guard).
 *
 * ## KTD-5 release policy
 *
 * We read our own receipt at the **sequencer** block and release the product
 * immediately. We do **not** wait for the safe block. On an OP Stack testnet a
 * sequencer block can be reorged, so in principle a report could be released
 * against a charge that later disappears — note that under merchant-pull the
 * reorg would un-pay the merchant, not the buyer. That risk is accepted
 * consciously: waiting for `safe` takes minutes and would destroy the point of
 * an agent paying for an API call in-line.
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
/* The call                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `charge` plus every custom error it can revert with.
 *
 * The errors are not decoration: viem can only name a custom error it has an ABI
 * entry for, and naming it is the difference between telling a buyer "your card
 * is scoped to a different merchant" and telling it "0x2b1c…". Mirrors
 * `smartcontracts/src/CardVault.sol`; `verify.test.ts` pins every selector
 * against its canonical signature, so an argument-type typo cannot pass.
 */
export const cardVaultChargeAbi = [
  {
    type: 'function',
    name: 'charge',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'cardId', type: 'uint256', internalType: 'uint256' },
      { name: 'amount', type: 'uint256', internalType: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'error',
    name: 'CardNotActive',
    inputs: [
      { name: 'cardId', type: 'uint256', internalType: 'uint256' },
      { name: 'status', type: 'uint8', internalType: 'enum CardStatus' },
    ],
  },
  {
    type: 'error',
    name: 'CardExpired',
    inputs: [
      { name: 'cardId', type: 'uint256', internalType: 'uint256' },
      { name: 'expiry', type: 'uint64', internalType: 'uint64' },
    ],
  },
  {
    type: 'error',
    name: 'MerchantScopeMismatch',
    inputs: [
      { name: 'cardId', type: 'uint256', internalType: 'uint256' },
      { name: 'caller', type: 'address', internalType: 'address' },
      { name: 'merchantScope', type: 'address', internalType: 'address' },
    ],
  },
  {
    type: 'error',
    name: 'ChargeExceedsCap',
    inputs: [
      { name: 'amount', type: 'uint256', internalType: 'uint256' },
      { name: 'cap', type: 'uint256', internalType: 'uint256' },
    ],
  },
  { type: 'error', name: 'ZeroAmount', inputs: [] },
] as const satisfies Abi

/**
 * `CardStatus` from `CardTypes.sol`, as the `uint8` the ABI encodes it to.
 *
 * Only `Used` needs its own payment code: "already spent" and "cancelled" call
 * for completely different buyer behaviour.
 */
const CARD_STATUS_USED = 2

/* -------------------------------------------------------------------------- */
/* Chain access                                                               */
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

/** What a merchant asks the vault to move. */
export interface ChargeRequest {
  readonly cardId: bigint
  /** Amount to pull, in token base units. The list price. */
  readonly amount: bigint
}

/**
 * The one write the merchant performs.
 *
 * Injected so the test suite never touches a live RPC or a real key, and so the
 * facilitator's blast radius is one method wide: it can charge a card, and it
 * cannot do anything else with the merchant's key.
 *
 * Implementations must throw a {@link PaymentError} — see
 * {@link classifyChargeFailure} — so the HTTP layer never sees a raw viem error.
 */
export interface ChargeSubmitter {
  /** Submit `CardVault.charge(cardId, amount)` and wait for its receipt. */
  submitCharge(request: ChargeRequest): Promise<ChargeReceipt>
}

/** The subset of a viem wallet client {@link createViemChargeSubmitter} needs. */
export interface ViemChargeWalletClient {
  writeContract(args: {
    address: Address
    abi: Abi | readonly unknown[]
    functionName: string
    args: readonly unknown[]
  }): Promise<Hash>
}

/** The subset of a viem public client {@link createViemChargeSubmitter} needs. */
export interface ViemChargeReceiptClient {
  waitForTransactionReceipt(args: { hash: Hash }): Promise<{
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

/** Walk a bounded `cause` chain, so a cycle cannot hang the classifier. */
function causeChain(error: unknown, maxDepth = 8): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && chain.length < maxDepth) {
    if (seen.has(current)) break
    seen.add(current)
    chain.push(current as Record<string, unknown>)
    current = (current as { cause?: unknown }).cause
  }
  return chain
}

/** Every text field a viem error hides its explanation in. */
function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  return causeChain(error)
    .flatMap((node) =>
      ['name', 'message', 'shortMessage', 'details', 'metaMessages'].map((field) => {
        const value = node[field]
        if (typeof value === 'string') return value
        if (Array.isArray(value)) return value.join(' ')
        return ''
      }),
    )
    .join(' ')
}

/** Pull viem's decoded custom-error name out of a thrown revert, if there is one. */
function revertedErrorName(error: unknown): { name: string; args: unknown[] } | null {
  for (const node of causeChain(error)) {
    if (node['name'] !== 'ContractFunctionRevertedError') continue
    const data = node['data']
    if (typeof data === 'object' && data !== null) {
      const errorName = (data as { errorName?: unknown }).errorName
      const args = (data as { args?: unknown }).args
      if (typeof errorName === 'string') {
        return { name: errorName, args: Array.isArray(args) ? args : [] }
      }
    }
    const reason = node['reason']
    if (typeof reason === 'string') return { name: reason, args: [] }
  }
  return null
}

/** Node prose for "this account cannot pay for the transaction it just sent". */
const UNFUNDED_PATTERNS: readonly RegExp[] = [
  /insufficient funds/i,
  /gas required exceeds allowance/i,
  /doesn't have enough funds/i,
  /exceeds the balance of the account/i,
]

function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(Math.trunc(value))
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  return 0n
}

/**
 * Turn whatever the chain threw at a `charge` into a {@link PaymentError}.
 *
 * The distinction that matters is *whose fault it is*. A card that is used,
 * expired, capped too low or scoped to another merchant is the buyer's problem
 * and gets a 402 naming it. An unfunded merchant key, a dead RPC or an
 * unrecognised revert is the merchant's problem and gets a 503 — telling an
 * agent to present another card because our own key ran out of ETH would be a
 * lie with a price tag on it.
 *
 * Note that none of the buyer-fault cases costs anyone gas: viem estimates gas
 * before it signs, so a doomed `charge` reverts at `eth_estimateGas` and is
 * never mined.
 */
export function classifyChargeFailure(error: unknown, request: ChargeRequest): PaymentError {
  if (error instanceof PaymentError) return error

  const revert = revertedErrorName(error)
  if (revert !== null) {
    switch (revert.name) {
      case 'MerchantScopeMismatch':
        return new PaymentError(
          'merchant_scope_mismatch',
          `Card ${request.cardId} is scoped to a different merchant, so this merchant cannot ` +
            'charge it. Present a card minted for this merchant address.',
        )

      case 'CardNotActive': {
        const status = Number(asBigInt(revert.args[1]))
        if (status === CARD_STATUS_USED) {
          return new PaymentError(
            'card_already_used',
            `Card ${request.cardId} has already been charged. A GiwaCard is chargeable exactly ` +
              'once; mint a new one for another report.',
          )
        }
        return new PaymentError(
          'card_not_active',
          `Card ${request.cardId} is not active (it was cancelled, reaped, or never minted), ` +
            'so it cannot be charged.',
        )
      }

      case 'CardExpired':
        return new PaymentError(
          'card_expired',
          `Card ${request.cardId} expired before it was presented; its escrow has been ` +
            'released. Mint a new card.',
        )

      case 'ChargeExceedsCap':
        return new PaymentError(
          'card_cap_too_low',
          `Card ${request.cardId} has a cap below the ${request.amount} base units this ` +
            'resource costs. Mint a card with a large enough cap.',
        )

      // Anything else the vault refuses with is a revert we have no advice for,
      // so it falls through to the merchant-side generic rather than being
      // reported to the buyer as something it could fix.
      default:
        break
    }
  }

  const text = errorText(error)
  if (UNFUNDED_PATTERNS.some((pattern) => pattern.test(text))) {
    return new PaymentError(
      'settlement_failed',
      'The merchant could not submit the settlement transaction: its own key has no ETH for ' +
        'gas on GIWA Sepolia. This is a merchant-side outage, not a rejected payment — your ' +
        'card was not charged.',
      { cause: error },
    )
  }

  return new PaymentError(
    'settlement_failed',
    'The merchant could not settle the payment onchain. This is a merchant-side failure, not ' +
      'a rejected payment; retry shortly.',
    { cause: error },
  )
}

/**
 * Adapt a viem wallet + public client pair to {@link ChargeSubmitter}.
 *
 * The wallet client must be bound to the merchant account whose address the
 * cards are scoped to — `config.ts` refuses to start otherwise, because a
 * mismatch would revert every single charge.
 */
export function createViemChargeSubmitter(options: {
  wallet: ViemChargeWalletClient
  receipts: ViemChargeReceiptClient
  vault: Address
}): ChargeSubmitter {
  return {
    async submitCharge(request) {
      let hash: Hash
      try {
        hash = await options.wallet.writeContract({
          address: options.vault,
          abi: cardVaultChargeAbi,
          functionName: 'charge',
          args: [request.cardId, request.amount],
        })
      } catch (error) {
        throw classifyChargeFailure(error, request)
      }

      try {
        const receipt = await options.receipts.waitForTransactionReceipt({ hash })
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
      } catch (cause) {
        // The charge is in flight and may well land; we simply cannot see it.
        throw new PaymentError(
          'chain_unavailable',
          `The merchant submitted settlement transaction ${hash} but could not read its ` +
            'receipt from GIWA Sepolia. This is a merchant-side failure; do not present ' +
            'another card until this one resolves.',
          { cause },
        )
      }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Replay store                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Tracks which cards have already been settled by this merchant.
 *
 * Keyed on **cardId**, which is the identifier the buyer presents. `claim` must
 * be atomic with respect to the event loop — it is called before the first
 * `await` of a settlement, so two concurrent requests presenting the same card
 * cannot both reach `CardVault.charge`.
 *
 * A settled card stays recorded with its {@link ChargeProof} until the product
 * is delivered, so a report that fails to generate *after* the money moved can
 * be retried without charging a second card. See {@link SettlementStore.record}.
 */
export interface SettlementStore {
  /** Reserve `cardId`. Returns `false` if it is already reserved or settled. */
  claim(cardId: bigint): boolean
  /** Undo a reservation whose settlement never happened, so a retry works. */
  release(cardId: bigint): void
  /** Record a paid-for product that has not shipped, so a retry can collect it. */
  record(cardId: bigint, proof: ChargeProof): void
  /**
   * Atomically take the undelivered settlement for `cardId`, if there is one.
   *
   * Taking flips the card out of the undelivered state in the same tick, so two
   * concurrent retries cannot both decide they are the one owed a report.
   */
  takeUndelivered(cardId: bigint): ChargeProof | null
  /** Mark the product delivered. The card stays claimed forever after. */
  consume(cardId: bigint): void
  /** Whether `cardId` is currently reserved, settled or consumed. */
  has(cardId: bigint): boolean
  /** Number of tracked cards. */
  readonly size: number
}

/**
 * Internal state of one tracked card.
 *
 * `undelivered` is the only re-servable state and it exists solely for the
 * window between "the money moved" and "the product shipped".
 */
type SettlementEntry =
  | { readonly phase: 'claimed' }
  | { readonly phase: 'undelivered'; readonly proof: ChargeProof }
  | { readonly phase: 'delivered' }

/**
 * In-memory {@link SettlementStore} with bounded FIFO eviction.
 *
 * A real merchant would persist this. For the demo an in-process Map is right,
 * with one honest caveat: once `maxEntries` is exceeded the oldest cardIds are
 * evicted, and a process restart forgets everything. What that re-opens is
 * *smaller* than it looks, because `CardVault` independently flips a charged
 * card to `Used`: a forgotten cardId presented again makes the merchant submit a
 * second `charge`, which the vault reverts with `CardNotActive`, so the buyer
 * gets a 402 and no money moves twice. The replay guard is therefore about not
 * wasting a transaction and not duplicating a report — never about custody.
 */
export class InMemorySettlementStore implements SettlementStore {
  readonly #entries = new Map<string, SettlementEntry>()
  readonly #maxEntries: number

  constructor(options: { maxEntries?: number } = {}) {
    const maxEntries = options.maxEntries ?? 100_000
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError(
        `InMemorySettlementStore: maxEntries must be a positive integer, got ${String(maxEntries)}`,
      )
    }
    this.#maxEntries = maxEntries
  }

  claim(cardId: bigint): boolean {
    const key = cardId.toString()
    if (this.#entries.has(key)) return false
    this.#entries.set(key, { phase: 'claimed' })
    // Map iteration order is insertion order, so the first key is the oldest.
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next()
      if (oldest.done === true) break
      this.#entries.delete(oldest.value)
    }
    return true
  }

  release(cardId: bigint): void {
    this.#entries.delete(cardId.toString())
  }

  record(cardId: bigint, proof: ChargeProof): void {
    this.#entries.set(cardId.toString(), { phase: 'undelivered', proof })
  }

  takeUndelivered(cardId: bigint): ChargeProof | null {
    const key = cardId.toString()
    const entry = this.#entries.get(key)
    if (entry === undefined || entry.phase !== 'undelivered') return null
    this.#entries.set(key, { phase: 'delivered' })
    return entry.proof
  }

  consume(cardId: bigint): void {
    this.#entries.set(cardId.toString(), { phase: 'delivered' })
  }

  has(cardId: bigint): boolean {
    return this.#entries.has(cardId.toString())
  }

  get size(): number {
    return this.#entries.size
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

/** Everything {@link verifyChargeReceipt} must be told to judge a settlement. */
export interface VerifyChargeInput {
  readonly cardId: bigint
  /** The one contract whose `CardCharged` events count. */
  readonly vault: Address
  /** The address that must have been paid — this merchant. */
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
 * Verify that a settlement receipt contains a `CardCharged` event paying this
 * merchant at least `minAmount` for `cardId`, emitted by `vault`.
 *
 * Pure and synchronous: the receipt is already in hand, replay protection lives
 * in {@link MerchantFacilitator}, and so this can be called safely from a test.
 *
 * @throws {PaymentError} with the specific reason the receipt was rejected.
 */
export function verifyChargeReceipt(
  receipt: ChargeReceipt,
  input: VerifyChargeInput,
): ChargeProof {
  if (receipt.status !== 'success') {
    throw new PaymentError(
      'settlement_failed',
      `The merchant's settlement transaction ${receipt.transactionHash} reverted after it was ` +
        'mined, so nothing was paid. This is a merchant-side failure; retry shortly.',
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
        `Settlement transaction ${receipt.transactionHash} emits CardCharged, but not from the ` +
          `vault this merchant is configured with (${input.vault}). A contract that merely ` +
          'emits the same event shape has not moved any gUSD.',
      )
    }
    throw new PaymentError(
      'no_charge_event',
      `Settlement transaction ${receipt.transactionHash} contains no CardCharged event from ` +
        `${input.vault}.`,
    )
  }

  const toMerchant = fromVault.filter((charge) => sameAddress(charge.merchant, input.merchant))
  if (toMerchant.length === 0) {
    throw new PaymentError(
      'wrong_merchant',
      `Settlement transaction ${receipt.transactionHash} charged a card, but paid ` +
        `${fromVault.map((charge) => charge.merchant).join(', ')} rather than this merchant (${input.merchant}).`,
    )
  }

  const forCard = toMerchant.filter((charge) => charge.cardId === input.cardId)
  if (forCard.length === 0) {
    throw new PaymentError(
      'card_id_mismatch',
      `The merchant charged card ${input.cardId}, but settlement transaction ` +
        `${receipt.transactionHash} settled card ` +
        `${toMerchant.map((charge) => charge.cardId.toString()).join(', ')}.`,
    )
  }

  const paid = forCard.find((charge) => charge.amount >= input.minAmount)
  if (paid === undefined) {
    const best = forCard.reduce((max, charge) => (charge.amount > max ? charge.amount : max), 0n)
    throw new PaymentError(
      'amount_below_price',
      `Card ${input.cardId} moved ${best} base units, below the ${input.minAmount} required.`,
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
  /** The one write the merchant performs: `CardVault.charge`. */
  readonly submitter: ChargeSubmitter
  /** The one contract whose `CardCharged` events count. */
  readonly vault: Address
  /** The address that must have been paid — this merchant. */
  readonly merchant: Address
  /** Replay store. Defaults to a fresh {@link InMemorySettlementStore}. */
  readonly store?: SettlementStore
}

/** A card presented for settlement, and what it must be worth. */
export interface FacilitatorSettleInput {
  readonly cardId: bigint
  /** List price of the resource being bought, in token base units. */
  readonly amount: bigint
}

/**
 * Charges a presented card, verifies the resulting event, and enforces
 * single-use cards.
 *
 * Holds the merchant's key only indirectly, through {@link ChargeSubmitter}: the
 * one thing it can make that key do is charge a card for a stated amount.
 */
export class MerchantFacilitator {
  readonly #submitter: ChargeSubmitter
  readonly #vault: Address
  readonly #merchant: Address
  readonly #store: SettlementStore

  constructor(options: MerchantFacilitatorOptions) {
    this.#submitter = options.submitter
    this.#vault = options.vault
    this.#merchant = options.merchant
    this.#store = options.store ?? new InMemorySettlementStore()
  }

  /** The vault this facilitator charges through, and trusts events from. */
  get vault(): Address {
    return this.#vault
  }

  /** The address this facilitator charges cards to. */
  get merchant(): Address {
    return this.#merchant
  }

  /** The replay store, exposed for operational inspection. */
  get store(): SettlementStore {
    return this.#store
  }

  /**
   * Take the settlement for a card that was charged but never got its product.
   *
   * The buyer's card is `Used` and their money is gone, so the only honest
   * response to a retry is to serve the report they paid for rather than
   * charging a second card. Taking is atomic: two concurrent retries cannot both
   * be handed the same undelivered settlement and both ship a report for it.
   *
   * Whoever takes one owns the obligation, and must hand it back with
   * {@link MerchantFacilitator.returnUndelivered} if it too fails to deliver.
   */
  takeSettled(cardId: bigint): ChargeProof | null {
    return this.#store.takeUndelivered(cardId)
  }

  /**
   * Settle a presented card: charge it, then verify our own receipt.
   *
   * The cardId is claimed *synchronously*, before the first `await`, so two
   * concurrent requests presenting the same card cannot both reach the chain. A
   * settlement that never made it onchain releases the claim again.
   *
   * A successful settlement leaves the card marked delivered, not undelivered:
   * the caller is holding the proof and therefore owns the obligation to ship.
   * If it cannot, it hands the proof back with {@link returnUndelivered}.
   *
   * @throws {PaymentError} `card_already_settled` when the card already bought a
   * report, whatever {@link classifyChargeFailure} rejected the charge with, or
   * whatever {@link verifyChargeReceipt} rejected the receipt with.
   */
  async settle(input: FacilitatorSettleInput): Promise<ChargeProof> {
    if (!this.#store.claim(input.cardId)) {
      throw new PaymentError(
        'card_already_settled',
        `Card ${input.cardId} has already been settled by this merchant. Each card buys ` +
          'exactly one report; present a new card for another.',
      )
    }

    const request: ChargeRequest = { cardId: input.cardId, amount: input.amount }

    let receipt: ChargeReceipt
    try {
      receipt = await this.#submitter.submitCharge(request)
    } catch (error) {
      // No receipt means no charge we can point at, so the card is free again.
      // `chain_unavailable` is the one case where that is a guess rather than a
      // fact — the transaction may yet land — but the vault, not this Map, is
      // what actually stops a second charge.
      this.#store.release(input.cardId)
      throw classifyChargeFailure(error, request)
    }

    // Note the absence of a `catch` here. The transaction is mined; whatever it
    // did or failed to do, submitting a second charge is not the fix. So a
    // verification failure keeps the claim and surfaces as a merchant-side 503.
    const proof = verifyChargeReceipt(receipt, {
      cardId: input.cardId,
      vault: this.#vault,
      merchant: this.#merchant,
      minAmount: input.amount,
    })

    this.#store.consume(input.cardId)
    return proof
  }

  /**
   * Hand an undelivered settlement back, so the buyer can collect it later.
   *
   * Called when the money moved but the product could not be produced. The card
   * is `Used` onchain — the buyer cannot pay again even if asked — so the debt
   * has to live somewhere until it is honoured.
   */
  returnUndelivered(cardId: bigint, proof: ChargeProof): void {
    this.#store.record(cardId, proof)
  }
}

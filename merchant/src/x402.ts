/**
 * The wire protocol: an x402-shaped payment scheme settled by `CardVault.charge`.
 *
 * ## Why not stock x402 `exact_evm`, and why not Permit2 (KTD-9)
 *
 * x402's `exact_evm` scheme settles with Permit2 `SignatureTransfer`, which
 * pulls tokens **from the signer's own ERC-20 balance**. In GiwaCard the gUSD is
 * escrowed *inside* `CardVault` and the paying session EOA holds no gUSD at all,
 * so that rail cannot settle: there is nothing in the signer's balance to pull.
 * And since `CardVault.charge` already moves funds from vault escrow to the
 * merchant in one transaction, a Permit2 hop would be redundant even if it
 * worked. So the scheme is ours — but the *shape* is deliberately x402's, so
 * that anyone who knows x402 can read it:
 *
 * 1. `GET /insights` with no payment → **402** whose body is the familiar
 *    `{ x402Version, error, accepts: [PaymentRequirements] }`.
 * 2. The client submits `CardVault.charge(cardId, amount)` from its session EOA.
 *    (That is the GiwaCard MCP server's job; the merchant never submits it.)
 * 3. The client retries with the **`X-PAYMENT`** request header carrying the
 *    transaction hash and the cardId.
 * 4. The merchant's built-in facilitator reads the chain and verifies a
 *    `CardCharged` event in that transaction. See `verify.ts`.
 * 5. On success the 200 carries a **`PAYMENT-RESPONSE`** header with the
 *    settlement receipt.
 *
 * The one field x402 does not have is `extra.vault`: without it the client would
 * not know which contract to call, and the facilitator's whole security model is
 * "events from *that* address and no other".
 */

import { isAddress, isHex, type Address, type Hash } from 'viem'

/** Protocol version, mirroring x402's own `x402Version`. */
export const X402_VERSION = 1 as const

/** Scheme identifier. Not `exact_evm`: see the module docblock. */
export const GIWA_VAULT_CHARGE_SCHEME = 'giwa-vault-charge' as const

/** Request header carrying the payment receipt. Same name as x402. */
export const PAYMENT_HEADER = 'X-PAYMENT' as const

/** Response header carrying the settlement receipt. Same name as x402. */
export const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE' as const

/** The `charge` entrypoint clients must call, as a human-readable signature. */
export const SETTLEMENT_CALL = 'CardVault.charge(uint256 cardId, uint256 amount)' as const

/** The event the facilitator verifies, as a human-readable signature. */
export const SETTLEMENT_EVENT =
  'CardCharged(uint256 indexed cardId, address indexed vaultOwner, address indexed merchant, uint256 amount, uint256 released)' as const

/**
 * KTD-5 release policy, stated on the wire so a client cannot claim surprise.
 *
 * The product is released as soon as the charge transaction is included in a
 * **sequencer block**. We do NOT wait for the safe block. On an OP Stack testnet
 * a sequencer block can in principle be reorged, so a merchant that released
 * against one could in principle be paid with a transaction that later vanishes.
 * We accept that consciously: waiting for the safe block takes minutes, which
 * would destroy the point of an agent paying for an API call. A production
 * merchant selling something irreversible should wait for `safe`.
 */
export const RELEASE_POLICY = 'sequencer-block' as const

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every way a payment can fail, as a stable machine-readable code.
 *
 * These are returned to the client in the 402 body's `reason` field so an agent
 * can branch without string-matching prose.
 */
export type PaymentErrorCode =
  /** No `X-PAYMENT` header at all — the ordinary first request. */
  | 'payment_required'
  /** Header present but not decodable, or missing required fields. */
  | 'malformed_payment_header'
  /** Header names a scheme this merchant does not implement. */
  | 'unsupported_scheme'
  /** Header names a different network. */
  | 'unsupported_network'
  /** The chain has no receipt for that hash (yet). */
  | 'transaction_not_found'
  /** The transaction exists but reverted, so nothing was paid. */
  | 'transaction_reverted'
  /** Receipt has no `CardCharged` event from any address. */
  | 'no_charge_event'
  /** A `CardCharged` event exists, but from a contract that is not our vault. */
  | 'wrong_vault'
  /** A `CardCharged` event exists from our vault, but pays someone else. */
  | 'wrong_merchant'
  /** Paid to us, but the cardId does not match the one in the header. */
  | 'card_id_mismatch'
  /** Paid to us for the right card, but for less than the list price. */
  | 'amount_below_price'
  /** This transaction hash already bought a report. */
  | 'receipt_already_used'
  /** The facilitator could not read the chain. Not the client's fault. */
  | 'chain_unavailable'

/** A payment that cannot be honoured, with a code the client can branch on. */
export class PaymentError extends Error {
  override readonly name = 'PaymentError'
  /** Stable machine-readable reason. */
  readonly code: PaymentErrorCode

  constructor(code: PaymentErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}

/**
 * HTTP status for a payment failure.
 *
 * Everything the client could fix by paying properly is a 402. `chain_unavailable`
 * is ours, not theirs, so it is a 503 — answering 402 there would tell an agent
 * to pay a second time for a report it already paid for.
 */
export function httpStatusForPaymentError(code: PaymentErrorCode): 402 | 503 {
  return code === 'chain_unavailable' ? 503 : 402
}

/* -------------------------------------------------------------------------- */
/* Payment requirements (the 402 body)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Scheme-specific fields. x402 leaves `extra` free-form; ours is the part that
 * makes a vault charge possible at all.
 */
export interface GiwaVaultChargeExtra {
  /** `CardVault` proxy the client must call, and the only trusted emitter. */
  readonly vault: Address
  /** Chain id the charge must land on. */
  readonly chainId: number
  /** Token symbol, for display. */
  readonly tokenSymbol: string
  /** Token decimals, so a client can render `maxAmountRequired`. */
  readonly tokenDecimals: number
  /** Human-readable price, e.g. `'1'`. */
  readonly priceDisplay: string
  /** The call the client must submit. */
  readonly settlementCall: typeof SETTLEMENT_CALL
  /** The event the facilitator verifies. */
  readonly settlementEvent: typeof SETTLEMENT_EVENT
  /** Fields the client must put in the `X-PAYMENT` payload. */
  readonly payloadFields: readonly ['transactionHash', 'cardId']
  /** KTD-5: released at sequencer inclusion, not at the safe block. */
  readonly releasePolicy: typeof RELEASE_POLICY
  /** One-line statement of the reorg risk that policy accepts. */
  readonly releasePolicyNote: string
}

/** One acceptable way to pay, in x402's `accepts[]` shape. */
export interface PaymentRequirements {
  /** Scheme id — always {@link GIWA_VAULT_CHARGE_SCHEME}. */
  readonly scheme: typeof GIWA_VAULT_CHARGE_SCHEME
  /** Network slug, e.g. `giwa-sepolia`. */
  readonly network: string
  /** Price in token base units, as a decimal string. */
  readonly maxAmountRequired: string
  /** Absolute URL of the paid resource. */
  readonly resource: string
  /** What the money buys. */
  readonly description: string
  /** Content type the paid resource returns. */
  readonly mimeType: string
  /** Address that must appear as `merchant` in `CardCharged`. */
  readonly payTo: Address
  /** How long the client may take to present a receipt. */
  readonly maxTimeoutSeconds: number
  /** Token contract — gUSD. */
  readonly asset: Address
  /** Scheme-specific fields. */
  readonly extra: GiwaVaultChargeExtra
}

/** Body of a 402 response, in x402's shape plus a machine-readable `reason`. */
export interface PaymentRequiredBody {
  readonly x402Version: typeof X402_VERSION
  /** Human-readable explanation. */
  readonly error: string
  /** Machine-readable counterpart of {@link PaymentRequiredBody.error}. */
  readonly reason: PaymentErrorCode
  /** Every acceptable way to pay. Exactly one, for this merchant. */
  readonly accepts: readonly PaymentRequirements[]
}

/** The subset of {@link import('./config.js').MerchantConfig} this module needs. */
export interface RequirementsConfig {
  readonly merchantAddress: Address
  readonly vaultAddress: Address
  readonly tokenAddress: Address
  readonly tokenSymbol: string
  readonly tokenDecimals: number
  readonly priceAtomic: bigint
  readonly priceDisplay: string
  readonly chainId: number
  readonly network: string
  readonly baseUrl: string
  readonly maxTimeoutSeconds: number
}

/** What a specific paid resource costs and claims to return. */
export interface PaidResourceSpec {
  /** Path of the resource, e.g. `/insights`. */
  readonly path: string
  /** What the money buys. */
  readonly description: string
  /** Content type of the paid response. Defaults to `application/json`. */
  readonly mimeType?: string
}

/**
 * Build the `accepts[]` entry for one paid resource.
 *
 * Carries everything a client needs to pay without a second round trip: who to
 * pay (`payTo`), how much (`maxAmountRequired`, base units), in what
 * (`asset` + `extra.tokenDecimals`), through which contract (`extra.vault`), on
 * which chain (`extra.chainId`), by calling what (`extra.settlementCall`).
 */
export function buildPaymentRequirements(
  config: RequirementsConfig,
  resource: PaidResourceSpec,
): PaymentRequirements {
  return {
    scheme: GIWA_VAULT_CHARGE_SCHEME,
    network: config.network,
    maxAmountRequired: config.priceAtomic.toString(),
    resource: `${config.baseUrl}${resource.path}`,
    description: resource.description,
    mimeType: resource.mimeType ?? 'application/json',
    payTo: config.merchantAddress,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
    asset: config.tokenAddress,
    extra: {
      vault: config.vaultAddress,
      chainId: config.chainId,
      tokenSymbol: config.tokenSymbol,
      tokenDecimals: config.tokenDecimals,
      priceDisplay: config.priceDisplay,
      settlementCall: SETTLEMENT_CALL,
      settlementEvent: SETTLEMENT_EVENT,
      payloadFields: ['transactionHash', 'cardId'],
      releasePolicy: RELEASE_POLICY,
      releasePolicyNote:
        'The report is released once the charge is included in a sequencer block; ' +
        'the merchant does not wait for the safe block. Consciously accepted testnet reorg risk (KTD-5).',
    },
  }
}

/** Wrap requirements in the 402 body. */
export function buildPaymentRequiredBody(
  requirements: PaymentRequirements,
  failure: { code: PaymentErrorCode; message: string },
): PaymentRequiredBody {
  return {
    x402Version: X402_VERSION,
    error: failure.message,
    reason: failure.code,
    accepts: [requirements],
  }
}

/* -------------------------------------------------------------------------- */
/* X-PAYMENT header                                                           */
/* -------------------------------------------------------------------------- */

/** Decoded `X-PAYMENT` header. */
export interface PaymentPayload {
  readonly x402Version: number
  readonly scheme: typeof GIWA_VAULT_CHARGE_SCHEME
  readonly network: string
  readonly payload: {
    /** Hash of the `CardVault.charge` transaction the client submitted. */
    readonly transactionHash: Hash
    /** Card the client charged. Must match the event's `cardId`. */
    readonly cardId: bigint
  }
}

/** Wire form of {@link PaymentPayload}: `cardId` is a decimal string. */
interface PaymentPayloadWire {
  x402Version: number
  scheme: string
  network: string
  payload: {
    transactionHash: string
    cardId: string
  }
}

/**
 * Serialise a payment payload into an `X-PAYMENT` header value.
 *
 * Base64 like x402, so the header survives proxies that dislike raw JSON.
 */
export function encodePaymentHeader(payment: PaymentPayload): string {
  const wire: PaymentPayloadWire = {
    x402Version: payment.x402Version,
    scheme: payment.scheme,
    network: payment.network,
    payload: {
      transactionHash: payment.payload.transactionHash,
      cardId: payment.payload.cardId.toString(),
    },
  }
  return Buffer.from(JSON.stringify(wire), 'utf8').toString('base64')
}

function malformed(detail: string): PaymentError {
  return new PaymentError(
    'malformed_payment_header',
    `Malformed ${PAYMENT_HEADER} header: ${detail}. Expected base64 (or raw) JSON ` +
      `{"x402Version":${X402_VERSION},"scheme":"${GIWA_VAULT_CHARGE_SCHEME}","network":"<network>",` +
      `"payload":{"transactionHash":"0x…64 hex","cardId":"<decimal>"}}.`,
  )
}

/** Base64 / base64url, allowing an unpadded tail. */
const BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/

function parseHeaderJson(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === '') throw malformed('the header is empty')

  // Raw JSON is accepted as a developer convenience (`curl -H 'X-PAYMENT: {...}'`).
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed)
    } catch (cause) {
      throw new PaymentError(
        'malformed_payment_header',
        `Malformed ${PAYMENT_HEADER} header: the value looks like JSON but does not parse.`,
        { cause },
      )
    }
  }

  if (!BASE64_PATTERN.test(trimmed)) {
    throw malformed('the value is neither JSON nor base64')
  }

  let decoded: string
  try {
    decoded = Buffer.from(trimmed, 'base64').toString('utf8')
  } catch (cause) {
    throw new PaymentError(
      'malformed_payment_header',
      `Malformed ${PAYMENT_HEADER} header: base64 decoding failed.`,
      { cause },
    )
  }
  try {
    return JSON.parse(decoded)
  } catch (cause) {
    throw new PaymentError(
      'malformed_payment_header',
      `Malformed ${PAYMENT_HEADER} header: the base64 payload is not JSON.`,
      { cause },
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A 32-byte transaction hash, lowercase or mixed case. */
function parseTransactionHash(value: unknown): Hash {
  if (typeof value !== 'string') {
    throw malformed('payload.transactionHash must be a string')
  }
  if (!isHex(value) || value.length !== 66) {
    throw malformed(
      `payload.transactionHash must be a 32-byte hex string (0x + 64 hex chars), got ${JSON.stringify(value)}`,
    )
  }
  // Hashes are compared as keys in the replay store, so normalise the case once.
  return value.toLowerCase() as Hash
}

/** Card ids start at 1 in `CardVault`, so 0 is never a real card. */
function parseCardId(value: unknown): bigint {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw malformed(`payload.cardId must be a whole number, got ${String(value)}`)
    }
    if (!Number.isSafeInteger(value)) {
      throw malformed('payload.cardId exceeds the safe integer range; send it as a string')
    }
    value = String(value)
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    throw malformed(
      `payload.cardId must be a decimal integer string, got ${JSON.stringify(value)}`,
    )
  }
  const parsed = BigInt(value.trim())
  if (parsed <= 0n) {
    throw malformed('payload.cardId must be greater than 0; CardVault card ids start at 1')
  }
  return parsed
}

/** Options for {@link decodePaymentHeader}. */
export interface DecodePaymentHeaderOptions {
  /** Network slug the merchant settles on. Mismatches are rejected. */
  readonly network: string
}

/**
 * Parse and validate an `X-PAYMENT` header value.
 *
 * Accepts base64 (padded or not, standard or url-safe) or raw JSON. Absent
 * `x402Version`, `scheme` and `network` default to this merchant's — a client
 * that says nothing is assumed to mean ours; a client that says something else
 * is rejected rather than silently reinterpreted.
 *
 * @throws {PaymentError} with `malformed_payment_header`, `unsupported_scheme`
 * or `unsupported_network`.
 */
export function decodePaymentHeader(
  raw: string | undefined | null,
  options: DecodePaymentHeaderOptions,
): PaymentPayload {
  if (raw === undefined || raw === null) {
    throw malformed('the header is absent')
  }

  const parsed = parseHeaderJson(raw)
  if (!isRecord(parsed)) {
    throw malformed('the decoded value is not a JSON object')
  }

  const version = parsed['x402Version'] ?? X402_VERSION
  if (version !== X402_VERSION) {
    throw malformed(
      `x402Version ${JSON.stringify(version)} is not supported; this merchant speaks version ${X402_VERSION}`,
    )
  }

  const scheme = parsed['scheme'] ?? GIWA_VAULT_CHARGE_SCHEME
  if (scheme !== GIWA_VAULT_CHARGE_SCHEME) {
    throw new PaymentError(
      'unsupported_scheme',
      `Unsupported payment scheme ${JSON.stringify(scheme)}. This merchant only accepts ` +
        `"${GIWA_VAULT_CHARGE_SCHEME}" — settlement happens through CardVault.charge, not Permit2 (KTD-9).`,
    )
  }

  const network = parsed['network'] ?? options.network
  if (network !== options.network) {
    throw new PaymentError(
      'unsupported_network',
      `Unsupported network ${JSON.stringify(network)}. This merchant settles on "${options.network}".`,
    )
  }

  const payload = parsed['payload']
  if (!isRecord(payload)) {
    throw malformed('payload is missing or is not an object')
  }

  return {
    x402Version: X402_VERSION,
    scheme: GIWA_VAULT_CHARGE_SCHEME,
    network: options.network,
    payload: {
      transactionHash: parseTransactionHash(payload['transactionHash']),
      cardId: parseCardId(payload['cardId']),
    },
  }
}

/* -------------------------------------------------------------------------- */
/* PAYMENT-RESPONSE header                                                    */
/* -------------------------------------------------------------------------- */

/** Settlement receipt returned in the `PAYMENT-RESPONSE` header. */
export interface SettlementResponse {
  readonly success: true
  readonly x402Version: typeof X402_VERSION
  readonly scheme: typeof GIWA_VAULT_CHARGE_SCHEME
  readonly network: string
  /** Hash of the verified `CardVault.charge` transaction. */
  readonly transaction: Hash
  /** Vault owner whose escrow funded the charge — the economic payer. */
  readonly payer: Address
  /** Address paid. Always this merchant. */
  readonly payee: Address
  /** Vault that emitted the verified event. */
  readonly vault: Address
  /** Card that was charged, as a decimal string. */
  readonly cardId: string
  /** Amount charged, in token base units. */
  readonly amount: string
  /** Unspent cap returned to the vault owner, in token base units. */
  readonly released: string
  /** Token the charge settled in. */
  readonly asset: Address
  /** Sequencer block the charge landed in. */
  readonly blockNumber: string
  /** Hash of that block. */
  readonly blockHash: Hash
  /** Index of the verified log within the block. */
  readonly logIndex: number
  /** KTD-5: released at sequencer inclusion, not at the safe block. */
  readonly releasePolicy: typeof RELEASE_POLICY
  /** When the merchant released the product. */
  readonly settledAt: string
}

/** Serialise a settlement receipt into a `PAYMENT-RESPONSE` header value. */
export function encodeSettlementHeader(settlement: SettlementResponse): string {
  return Buffer.from(JSON.stringify(settlement), 'utf8').toString('base64')
}

/**
 * Inverse of {@link encodeSettlementHeader}. Provided so clients (and the tests)
 * do not hand-roll base64 + JSON.
 *
 * @throws {PaymentError} when the header is not a decodable settlement receipt.
 */
export function decodeSettlementHeader(raw: string): SettlementResponse {
  const parsed = parseHeaderJson(raw)
  if (!isRecord(parsed) || parsed['success'] !== true) {
    throw new PaymentError(
      'malformed_payment_header',
      `Malformed ${PAYMENT_RESPONSE_HEADER} header: not a settlement receipt.`,
    )
  }
  const transaction = parsed['transaction']
  const payee = parsed['payee']
  if (typeof transaction !== 'string' || typeof payee !== 'string' || !isAddress(payee)) {
    throw new PaymentError(
      'malformed_payment_header',
      `Malformed ${PAYMENT_RESPONSE_HEADER} header: missing transaction or payee.`,
    )
  }
  return parsed as unknown as SettlementResponse
}

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
 * that anyone who knows x402 can read it.
 *
 * ## Who submits the charge: the merchant (KTD-9)
 *
 * `CardVault.charge` requires `msg.sender == card.merchantScope` and transfers
 * the funds to `msg.sender`. The direction is therefore fixed by the contract:
 * **the merchant pulls**, exactly like a real card, where the holder presents the
 * card and the merchant is the one who runs it. A client that submitted `charge`
 * itself would revert with `MerchantScopeMismatch` and pay nobody.
 *
 * 1. `GET /insights` with no payment → **402** whose body is the familiar
 *    `{ x402Version, error, accepts: [PaymentRequirements] }`.
 * 2. The client retries with the **`X-PAYMENT`** request header naming the
 *    **`cardId`** it is presenting (plus the vault and chain id it expects, so a
 *    misconfigured merchant fails loudly instead of charging through the wrong
 *    contract). No transaction has happened yet, and the client never spends gas.
 * 3. The merchant's built-in facilitator submits `CardVault.charge(cardId, price)`
 *    from its own funded key and waits for the receipt.
 * 4. It then verifies the `CardCharged` event on **its own** transaction. See
 *    `verify.ts` — the checks are the same ones a read-only facilitator would
 *    run, and they are still worth running: they are what turns "the RPC did not
 *    throw" into "the vault I trust moved the amount I asked for".
 * 5. On success the 200 carries a **`PAYMENT-RESPONSE`** header whose
 *    `transaction` is the settlement tx hash — the client's receipt.
 *
 * The one field x402 does not have is `extra.vault`: without it the client would
 * not know which vault its card must live in, and the facilitator's whole
 * security model is "events from *that* address and no other".
 */

import { isAddress, isHex, type Address, type Hash } from 'viem'

/** Protocol version, mirroring x402's own `x402Version`. */
export const X402_VERSION = 1 as const

/** Scheme identifier. Not `exact_evm`: see the module docblock. */
export const GIWA_VAULT_CHARGE_SCHEME = 'giwa-vault-charge' as const

/** Request header carrying the card being presented. Same name as x402. */
export const PAYMENT_HEADER = 'X-PAYMENT' as const

/** Response header carrying the settlement receipt. Same name as x402. */
export const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE' as const

/** The `charge` entrypoint the merchant submits, as a human-readable signature. */
export const SETTLEMENT_CALL = 'CardVault.charge(uint256 cardId, uint256 amount)' as const

/** The event the facilitator verifies on its own receipt. */
export const SETTLEMENT_EVENT =
  'CardCharged(uint256 indexed cardId, address indexed vaultOwner, address indexed merchant, uint256 amount, uint256 released)' as const

/** Who submits {@link SETTLEMENT_CALL}. Stated on the wire so nobody guesses. */
export const SETTLEMENT_SUBMITTER = 'merchant' as const

/**
 * KTD-5 release policy, stated on the wire so a client cannot claim surprise.
 *
 * The product is released as soon as the merchant's own charge transaction is
 * included in a **sequencer block**. We do NOT wait for the safe block. On an OP
 * Stack testnet a sequencer block can in principle be reorged, so a merchant that
 * released against one could in principle have delivered against a transaction
 * that later vanishes. We accept that consciously: waiting for the safe block
 * takes minutes, which would destroy the point of an agent paying for an API call
 * in-line. Note which way the risk points here — under merchant-pull the reorg
 * would un-pay the *merchant*, not the buyer. A production merchant selling
 * something irreversible should wait for `safe`.
 */
export const RELEASE_POLICY = 'sequencer-block' as const

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every way a payment can fail, as a stable machine-readable code.
 *
 * These are returned to the client in the 402 body's `reason` field so an agent
 * can branch without string-matching prose. They fall into three groups:
 * malformed requests, cards the vault refused, and merchant-side failures.
 */
export type PaymentErrorCode =
  /* -- the client's request ------------------------------------------------ */
  /** No `X-PAYMENT` header at all — the ordinary first request. */
  | 'payment_required'
  /** Header present but not decodable, or missing required fields. */
  | 'malformed_payment_header'
  /** Header names a scheme this merchant does not implement. */
  | 'unsupported_scheme'
  /** Header names a different network, or a different chain id. */
  | 'unsupported_network'
  /** Header names a `CardVault` this merchant does not settle through. */
  | 'vault_mismatch'
  /** This cardId already bought a report from this merchant. */
  | 'card_already_settled'

  /* -- the vault refused the charge ---------------------------------------- */
  /** The card was already charged — `CardNotActive` with status `Used` (AE3). */
  | 'card_already_used'
  /** The card is cancelled, reaped, or was never minted. */
  | 'card_not_active'
  /** The card outlived its expiry and can no longer be charged. */
  | 'card_expired'
  /** The card's cap is below the list price, so the charge cannot be made. */
  | 'card_cap_too_low'
  /** The card is scoped to a different merchant, so this one cannot charge it. */
  | 'merchant_scope_mismatch'

  /* -- merchant-side ------------------------------------------------------- */
  /** The merchant could not submit the charge: unfunded key, RPC down, timeout. */
  | 'settlement_failed'
  /** The facilitator could not read the chain. Not the client's fault. */
  | 'chain_unavailable'
  /** The merchant's own successful transaction carried no `CardCharged` event. */
  | 'no_charge_event'
  /** A `CardCharged` event exists, but from a contract that is not our vault. */
  | 'wrong_vault'
  /** A `CardCharged` event exists from our vault, but pays someone else. */
  | 'wrong_merchant'
  /** The event's cardId is not the card the merchant charged. */
  | 'card_id_mismatch'
  /** The event moved less than the list price. */
  | 'amount_below_price'

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
 * Codes that are the *merchant's* problem, not the buyer's.
 *
 * Under merchant-pull the last five are all "our own transaction did not do what
 * we asked it to". Answering 402 there would tell an agent to present another
 * card for a charge that may already have moved money, so they are 503.
 */
const MERCHANT_SIDE_CODES: ReadonlySet<PaymentErrorCode> = new Set([
  'settlement_failed',
  'chain_unavailable',
  'no_charge_event',
  'wrong_vault',
  'wrong_merchant',
  'card_id_mismatch',
  'amount_below_price',
])

/**
 * HTTP status for a payment failure.
 *
 * Everything the client could fix — by presenting a different card, or by
 * presenting it correctly — is a 402. Everything else is a 503.
 */
export function httpStatusForPaymentError(code: PaymentErrorCode): 402 | 503 {
  return MERCHANT_SIDE_CODES.has(code) ? 503 : 402
}

/* -------------------------------------------------------------------------- */
/* Payment requirements (the 402 body)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Scheme-specific fields. x402 leaves `extra` free-form; ours is the part that
 * makes a vault charge possible at all.
 */
export interface GiwaVaultChargeExtra {
  /** `CardVault` proxy the merchant charges through, and the only trusted emitter. */
  readonly vault: Address
  /** Chain id the charge will land on. */
  readonly chainId: number
  /** Token symbol, for display. */
  readonly tokenSymbol: string
  /** Token decimals, so a client can render `maxAmountRequired`. */
  readonly tokenDecimals: number
  /** Human-readable price, e.g. `'1'`. */
  readonly priceDisplay: string
  /** The call that settles the payment. */
  readonly settlementCall: typeof SETTLEMENT_CALL
  /** Who submits it. Always the merchant — see the module docblock. */
  readonly settledBy: typeof SETTLEMENT_SUBMITTER
  /** The event the facilitator verifies on its own receipt. */
  readonly settlementEvent: typeof SETTLEMENT_EVENT
  /**
   * Fields the client may put in the `X-PAYMENT` payload. Only `cardId` is
   * required; `vault` and `chainId`, when present, are cross-checked against
   * this merchant's configuration and a mismatch is refused rather than settled.
   */
  readonly payloadFields: readonly ['cardId', 'vault', 'chainId']
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
  /** Address that will charge the card, and appear as `merchant` in `CardCharged`. */
  readonly payTo: Address
  /** How long the client may take to present a card. */
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
 * Carries everything a client needs to pay without a second round trip: who will
 * charge it (`payTo`), how much (`maxAmountRequired`, base units), in what
 * (`asset` + `extra.tokenDecimals`), through which contract (`extra.vault`), on
 * which chain (`extra.chainId`), by which call (`extra.settlementCall`) — and,
 * because it is the thing this codebase once got wrong, who submits that call
 * (`extra.settledBy`).
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
      settledBy: SETTLEMENT_SUBMITTER,
      settlementEvent: SETTLEMENT_EVENT,
      payloadFields: ['cardId', 'vault', 'chainId'],
      releasePolicy: RELEASE_POLICY,
      releasePolicyNote:
        'The report is released once the merchant charge is included in a sequencer block; ' +
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

/** Decoded `X-PAYMENT` header: the card a client presents. */
export interface PaymentPayload {
  readonly x402Version: number
  readonly scheme: typeof GIWA_VAULT_CHARGE_SCHEME
  readonly network: string
  readonly payload: {
    /** Card the merchant is authorised to charge. */
    readonly cardId: bigint
    /**
     * `CardVault` the client believes its card lives in. Optional; when present
     * it must be this merchant's vault. It protects the *client*: without it a
     * misconfigured merchant would silently charge through some other contract.
     */
    readonly vault?: Address
    /** Chain id the client expects. Optional, cross-checked when present. */
    readonly chainId?: number
  }
}

/** Wire form of {@link PaymentPayload}: `cardId` is a decimal string. */
interface PaymentPayloadWire {
  x402Version: number
  scheme: string
  network: string
  payload: {
    cardId: string
    vault?: Address
    chainId?: number
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
      cardId: payment.payload.cardId.toString(),
      ...(payment.payload.vault !== undefined ? { vault: payment.payload.vault } : {}),
      ...(payment.payload.chainId !== undefined
        ? { chainId: payment.payload.chainId }
        : {}),
    },
  }
  return Buffer.from(JSON.stringify(wire), 'utf8').toString('base64')
}

function malformed(detail: string): PaymentError {
  return new PaymentError(
    'malformed_payment_header',
    `Malformed ${PAYMENT_HEADER} header: ${detail}. Expected base64 (or raw) JSON ` +
      `{"x402Version":${X402_VERSION},"scheme":"${GIWA_VAULT_CHARGE_SCHEME}","network":"<network>",` +
      `"payload":{"cardId":"<decimal>","vault":"0x…","chainId":<number>}}. ` +
      'Only cardId is required; the merchant submits CardVault.charge itself.',
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

/** An optional 20-byte address field. Absent is fine; malformed is not. */
function parseOptionalAddress(field: string, value: unknown): Address | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw malformed(`payload.${field} must be a 20-byte hex address when present`)
  }
  return value as Address
}

/** An optional positive-integer field. */
function parseOptionalInt(field: string, value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed <= 0) {
    throw malformed(`payload.${field} must be a positive integer when present`)
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
 * Note what this function does *not* do: it does not check `payload.vault` or
 * `payload.chainId` against the merchant's configuration, because it is not told
 * them. {@link assertExpectedVenue} does that.
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

  const vault = parseOptionalAddress('vault', payload['vault'])
  const chainId = parseOptionalInt('chainId', payload['chainId'])

  return {
    x402Version: X402_VERSION,
    scheme: GIWA_VAULT_CHARGE_SCHEME,
    network: options.network,
    payload: {
      cardId: parseCardId(payload['cardId']),
      ...(vault !== undefined ? { vault } : {}),
      ...(chainId !== undefined ? { chainId } : {}),
    },
  }
}

/** What {@link assertExpectedVenue} compares the client's expectations against. */
export interface SettlementVenue {
  readonly vault: Address
  readonly chainId: number
}

/**
 * Refuse a payment whose client expects a different vault or chain than ours.
 *
 * Cheap, and it fails before any gas is spent. A client that omits both fields
 * is trusting the requirements it already read, which is its prerogative.
 *
 * @throws {PaymentError} `vault_mismatch` or `unsupported_network`.
 */
export function assertExpectedVenue(
  payload: PaymentPayload['payload'],
  venue: SettlementVenue,
): void {
  if (
    payload.vault !== undefined &&
    payload.vault.toLowerCase() !== venue.vault.toLowerCase()
  ) {
    throw new PaymentError(
      'vault_mismatch',
      `This merchant settles through CardVault ${venue.vault}, but the ${PAYMENT_HEADER} ` +
        `header expects ${payload.vault}. Present a card from the advertised vault.`,
    )
  }
  if (payload.chainId !== undefined && payload.chainId !== venue.chainId) {
    throw new PaymentError(
      'unsupported_network',
      `This merchant settles on chain ${venue.chainId}, but the ${PAYMENT_HEADER} header ` +
        `expects chain ${payload.chainId}.`,
    )
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
  /** Hash of the merchant's own `CardVault.charge` transaction. The receipt. */
  readonly transaction: Hash
  /** Vault owner whose escrow funded the charge — the economic payer. */
  readonly payer: Address
  /** Address paid, and the address that submitted the charge. Always this merchant. */
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
  if (
    typeof transaction !== 'string' ||
    !isHex(transaction) ||
    transaction.length !== 66 ||
    typeof payee !== 'string' ||
    !isAddress(payee)
  ) {
    throw new PaymentError(
      'malformed_payment_header',
      `Malformed ${PAYMENT_RESPONSE_HEADER} header: missing transaction or payee.`,
    )
  }
  return parsed as unknown as SettlementResponse
}

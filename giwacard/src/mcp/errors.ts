import { BaseError, ContractFunctionRevertedError } from 'viem'

import { RpcRetryLimitError } from '../chain/clients.js'
import { cardStatusName } from '../chain/cardVaultAbi.js'
import { DaemonError } from '../daemon/errors.js'

/**
 * The agent-facing error taxonomy (R7).
 *
 * An agent cannot read a stack trace and cannot ask a human what to do next. It
 * needs two things from a failure: a **stable code** it can branch on across
 * versions, and a **message that names the next action**. Everything in this
 * module exists to guarantee both, and to guarantee that nothing else — no
 * viem stack, no RPC URL, no key material — rides along.
 *
 * The mapping funnel is deliberately one-way: {@link toMcpError} turns any
 * thrown value into one of these, and {@link UNKNOWN_ERROR_MESSAGE} is where
 * anything unrecognised lands. A failure that cannot be classified is reported
 * as a generic RPC failure rather than surfaced verbatim, because an
 * unclassified error is exactly the case where we do not know what it contains.
 */

/** Stable, machine-branchable failure codes. Never renumbered or reused. */
export type McpErrorCode =
  /** The session EOA has no ETH to pay for gas on GIWA Sepolia. */
  | 'NO_GAS'
  /** Too many requests — the approval queue's limit, or the RPC's. */
  | 'RATE_LIMITED'
  /** An over-policy request is queued and the owner has not decided yet. */
  | 'APPROVAL_PENDING'
  /** The owner denied the over-policy request. Terminal. */
  | 'APPROVAL_DENIED'
  /** The over-policy request passed its TTL undecided. Terminal. */
  | 'APPROVAL_EXPIRED'
  /** No approval request with that id. */
  | 'APPROVAL_NOT_FOUND'
  /** AE3 — the card was already charged. Terminal: a card is charged once. */
  | 'CARD_ALREADY_USED'
  /** The card exists but is cancelled, reaped, or was never minted. */
  | 'CARD_NOT_ACTIVE'
  /** No card with that id. */
  | 'CARD_NOT_FOUND'
  /** The card outlived its expiry and can no longer be charged. */
  | 'CARD_EXPIRED'
  /** AE5 — the vault owner's unescrowed balance cannot cover the cap. */
  | 'INSUFFICIENT_AVAILABLE_BALANCE'
  /** AE7 — the merchant is not in scope for this session key or card. */
  | 'MERCHANT_OUT_OF_SCOPE'
  /** The vault owner revoked this session key. Terminal until re-registered. */
  | 'SESSION_KEY_REVOKED'
  /** Only the vault owner may do this; it cannot be done from a session key. */
  | 'OWNER_ACTION_REQUIRED'
  /** The tool arguments are individually valid but cannot be satisfied. */
  | 'INVALID_REQUEST'
  /** The MCP server has no keystore, vault address or session key configured. */
  | 'NOT_CONFIGURED'
  /** Safe generic. Any RPC or unclassified failure lands here. */
  | 'RPC_UNAVAILABLE'

/**
 * What the agent is told when nothing else matched.
 *
 * Fixed text, on purpose: the whole point of the generic is that the underlying
 * error is not trusted to be quotable.
 */
export const UNKNOWN_ERROR_MESSAGE =
  'The GIWA Sepolia RPC could not be reached or returned an unexpected result. ' +
  'This is usually transient — retry in a few seconds. If it persists, check ' +
  'the chain status with `giwacard status`.'

/**
 * A failure an agent can act on.
 *
 * `details` is merged into the tool result and must therefore only ever carry
 * non-secret, already-public values (amounts, addresses, card ids).
 */
export class McpToolError extends Error {
  override readonly name: string = 'McpToolError'
  readonly code: McpErrorCode
  /** Whether retrying the identical call could succeed. */
  readonly retryable: boolean
  /** Non-secret context merged into the tool result. */
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: McpErrorCode,
    message: string,
    options: {
      retryable?: boolean
      details?: Record<string, unknown>
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {})
    this.code = code
    this.retryable = options.retryable ?? false
    this.details = Object.freeze({ ...(options.details ?? {}) })
  }
}

/* -------------------------------------------------------------------------- */
/* Constructors, one per class in the taxonomy                                */
/* -------------------------------------------------------------------------- */

/** The session EOA cannot pay for gas. */
export function noGasError(sessionKey: string): McpToolError {
  return new McpToolError(
    'NO_GAS',
    `The session key ${sessionKey} has no ETH on GIWA Sepolia and cannot pay ` +
      'for gas. Ask the vault owner to run `giwacard faucet`, then retry.',
    { retryable: true, details: { sessionKey } },
  )
}

/** Too many requests, from the approval queue or the RPC. */
export function rateLimitedError(
  retryAfterMs: number,
  scope: 'approvals' | 'rpc' = 'approvals',
): McpToolError {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
  return new McpToolError(
    'RATE_LIMITED',
    scope === 'approvals'
      ? `Too many over-policy requests from this session key. Wait ${seconds}s ` +
          'before asking again, or keep the next card inside policy.'
      : `The GIWA Sepolia RPC is rate-limiting this client. Retry in ${seconds}s.`,
    { retryable: true, details: { retryAfterMs, scope } },
  )
}

/** An over-policy request is queued and undecided. */
export function approvalPendingError(approvalId: string): McpToolError {
  return new McpToolError(
    'APPROVAL_PENDING',
    `Approval request ${approvalId} is still waiting on the vault owner. ` +
      'Poll `check_approval_status` with this approval_id; do not re-file it.',
    { retryable: true, details: { approvalId } },
  )
}

/** AE3 — the card has already been charged. */
export function cardAlreadyUsedError(cardId: string): McpToolError {
  return new McpToolError(
    'CARD_ALREADY_USED',
    `Card ${cardId} has already been charged. A card is chargeable exactly ` +
      'once; mint a new one for another payment.',
    { details: { cardId } },
  )
}

/** AE5 — not enough unescrowed balance to back the card. */
export function insufficientAvailableBalanceError(
  available: bigint,
  required: bigint,
): McpToolError {
  return new McpToolError(
    'INSUFFICIENT_AVAILABLE_BALANCE',
    `The vault has ${available} available but this card needs ${required} ` +
      '(base units). Funds locked behind active cards do not count — cancel an ' +
      'unused card, or ask the vault owner to deposit more.',
    {
      details: {
        available: available.toString(),
        required: required.toString(),
      },
    },
  )
}

/** AE7 — the merchant is outside the session key's or the card's scope. */
export function merchantOutOfScopeError(
  merchant: string,
  context: 'mint' | 'charge' = 'mint',
): McpToolError {
  return new McpToolError(
    'MERCHANT_OUT_OF_SCOPE',
    context === 'mint'
      ? `Merchant ${merchant} is not on this session key's allowlist, so no ` +
          'card can be scoped to it. Ask the vault owner to add it with ' +
          '`giwacard merchants add`. Raising the cap will not help.'
      : `This card is not scoped to merchant ${merchant} and cannot be charged ` +
          'by it. Use the card at the merchant it was minted for.',
    { details: { merchant, context } },
  )
}

/** The vault owner revoked this session key. */
export function sessionKeyRevokedError(
  sessionKey: string,
  vaultOwner: string,
): McpToolError {
  return new McpToolError(
    'SESSION_KEY_REVOKED',
    `Session key ${sessionKey} is not active for vault owner ${vaultOwner}. ` +
      'It was revoked or never registered. Stop retrying and tell the user to ' +
      'run `giwacard init` or re-register the key.',
    { details: { sessionKey, vaultOwner } },
  )
}

/** The safe generic. Carries no cause text, ever. */
export function rpcUnavailableError(cause?: unknown): McpToolError {
  return new McpToolError('RPC_UNAVAILABLE', UNKNOWN_ERROR_MESSAGE, {
    retryable: true,
    ...(cause !== undefined ? { cause } : {}),
  })
}

/* -------------------------------------------------------------------------- */
/* Revert decoding                                                            */
/* -------------------------------------------------------------------------- */

/** Walk an error's `cause` chain looking for viem's decoded revert. */
function findRevert(error: unknown): ContractFunctionRevertedError | null {
  if (error instanceof ContractFunctionRevertedError) return error
  if (error instanceof BaseError) {
    const found = error.walk(
      (candidate) => candidate instanceof ContractFunctionRevertedError,
    )
    if (found instanceof ContractFunctionRevertedError) return found
  }
  let current: unknown = error
  for (let depth = 0; depth < 8 && current; depth++) {
    if (current instanceof ContractFunctionRevertedError) return current
    current = (current as { cause?: unknown }).cause
  }
  return null
}

function argAt(revert: ContractFunctionRevertedError, index: number): unknown {
  const args = revert.data?.args
  return Array.isArray(args) ? args[index] : undefined
}

function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(Math.trunc(value))
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  return 0n
}

function asAddress(value: unknown): string {
  return typeof value === 'string' ? value : '0x0'
}

/**
 * Map a decoded `CardVault` custom error onto the taxonomy.
 *
 * Returns `null` for a revert this module has no specific advice for, so the
 * caller falls through to the safe generic rather than quoting raw revert data.
 */
export function mapVaultRevert(
  revert: ContractFunctionRevertedError,
): McpToolError | null {
  const name = revert.data?.errorName ?? revert.reason ?? ''

  switch (name) {
    case 'SessionKeyNotActive':
      return sessionKeyRevokedError(
        asAddress(argAt(revert, 1)),
        asAddress(argAt(revert, 0)),
      )

    case 'InsufficientAvailableBalance':
      return insufficientAvailableBalanceError(
        asBigInt(argAt(revert, 0)),
        asBigInt(argAt(revert, 1)),
      )

    case 'MerchantNotAllowed':
      return merchantOutOfScopeError(asAddress(argAt(revert, 2)), 'mint')

    case 'MerchantScopeMismatch':
      return merchantOutOfScopeError(asAddress(argAt(revert, 2)), 'charge')

    case 'CardNotActive': {
      const cardId = asBigInt(argAt(revert, 0)).toString()
      const status = cardStatusName(Number(asBigInt(argAt(revert, 1))))
      // `Used` is AE3 and gets its own code: "already spent" and "cancelled"
      // call for completely different agent behaviour.
      if (status === 'used') return cardAlreadyUsedError(cardId)
      return new McpToolError(
        status === 'none' ? 'CARD_NOT_FOUND' : 'CARD_NOT_ACTIVE',
        status === 'none'
          ? `No card with id ${cardId} exists in this vault.`
          : `Card ${cardId} is ${status} and can no longer be used. Mint a new one.`,
        { details: { cardId, status } },
      )
    }

    case 'CardExpired':
      return new McpToolError(
        'CARD_EXPIRED',
        `Card ${asBigInt(argAt(revert, 0))} expired and can no longer be ` +
          'charged. Its escrow is released; mint a new card.',
        { details: { cardId: asBigInt(argAt(revert, 0)).toString() } },
      )

    case 'NotCardOwner':
      return new McpToolError(
        'OWNER_ACTION_REQUIRED',
        `Card ${asBigInt(argAt(revert, 0))} can only be cancelled by the vault ` +
          'owner. Ask the user to run `giwacard cancel` or use the dashboard.',
        { details: { cardId: asBigInt(argAt(revert, 0)).toString() } },
      )

    case 'CapPerCardExceeded':
      return new McpToolError(
        'INVALID_REQUEST',
        `A cap of ${asBigInt(argAt(revert, 0))} exceeds this session key's ` +
          `per-card limit of ${asBigInt(argAt(revert, 1))}. Ask for less, or ` +
          'file an over-policy request.',
        {
          details: {
            cap: asBigInt(argAt(revert, 0)).toString(),
            limit: asBigInt(argAt(revert, 1)).toString(),
          },
        },
      )

    case 'DailyCapExceeded':
      return new McpToolError(
        'INVALID_REQUEST',
        `This card would take today's minted total to ` +
          `${asBigInt(argAt(revert, 0))}, past the daily cap of ` +
          `${asBigInt(argAt(revert, 1))}. Retry tomorrow or ask for less.`,
        {
          details: {
            wouldBeTotal: asBigInt(argAt(revert, 0)).toString(),
            limit: asBigInt(argAt(revert, 1)).toString(),
          },
        },
      )

    case 'ExpiryTooFar':
      return new McpToolError(
        'INVALID_REQUEST',
        `The requested expiry is later than this session key allows ` +
          `(latest ${asBigInt(argAt(revert, 1))}). Ask for a shorter-lived card.`,
        { details: { latestAllowed: asBigInt(argAt(revert, 1)).toString() } },
      )

    case 'ExpiryInPast':
      return new McpToolError(
        'INVALID_REQUEST',
        'The requested expiry is already in the past. Use a future timestamp.',
      )

    case 'ChargeExceedsCap':
      return new McpToolError(
        'INVALID_REQUEST',
        `A charge of ${asBigInt(argAt(revert, 0))} exceeds the card's cap of ` +
          `${asBigInt(argAt(revert, 1))}.`,
        {
          details: {
            amount: asBigInt(argAt(revert, 0)).toString(),
            cap: asBigInt(argAt(revert, 1)).toString(),
          },
        },
      )

    case 'ApprovalAlreadyUsed':
      return new McpToolError(
        'INVALID_REQUEST',
        'That owner approval has already been spent on a card. Call ' +
          '`check_approval_status` to find the card it minted.',
      )

    case 'ZeroAmount':
      return new McpToolError(
        'INVALID_REQUEST',
        'The amount must be greater than zero.',
      )

    default:
      return null
  }
}

/* -------------------------------------------------------------------------- */
/* The funnel                                                                 */
/* -------------------------------------------------------------------------- */

/** Daemon queue codes that have a direct agent-facing equivalent. */
function mapDaemonError(error: DaemonError): McpToolError {
  switch (error.code) {
    case 'APPROVAL_RATE_LIMITED':
      return rateLimitedError(
        Number(error.details['retryAfterMs'] ?? 60_000),
        'approvals',
      )

    case 'APPROVAL_REQUEST_NOT_FOUND':
      return new McpToolError(
        'APPROVAL_NOT_FOUND',
        'No approval request with that approval_id. It may have been filed ' +
          'against a different vault, or the daemon database was reset.',
        { details: { ...error.details } },
      )

    case 'APPROVAL_REQUEST_EXPIRED':
      return new McpToolError(
        'APPROVAL_EXPIRED',
        'That approval request expired before the vault owner decided. File a ' +
          'new one — expiry is terminal.',
        { details: { ...error.details } },
      )

    case 'APPROVAL_REQUEST_INVALID':
      return new McpToolError(
        'INVALID_REQUEST',
        'The approval request was rejected as malformed by the local daemon.',
        { details: { ...error.details } },
      )

    // Everything else is daemon plumbing (SQLite missing, CSRF, bind). The
    // agent can do nothing about any of it, so it gets the safe generic.
    default:
      return new McpToolError(
        'RPC_UNAVAILABLE',
        'The local giwacard approval daemon is unavailable. Ask the user to ' +
          'run `giwacard daemon` and check for errors.',
        { retryable: true, cause: error },
      )
  }
}

/** Heuristics for gas exhaustion, which viem reports as prose, not a revert. */
const NO_GAS_PATTERNS: readonly RegExp[] = [
  /insufficient funds for (gas|intrinsic transaction cost)/i,
  /gas required exceeds allowance/i,
  /sender doesn't have enough funds/i,
  /exceeds the balance of the account/i,
]

function looksLikeNoGas(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.message} ${(error as { details?: string }).details ?? ''} ` +
        `${(error as { shortMessage?: string }).shortMessage ?? ''}`
      : String(error)
  return NO_GAS_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * Turn anything thrown anywhere in a tool into an {@link McpToolError}.
 *
 * This is the only path a failure takes to an agent. Order runs
 * most-specific-first: an already-classified error passes through, then the
 * daemon's own taxonomy, then a decoded contract revert, then gas heuristics,
 * then rate limiting — and anything left is the safe generic.
 *
 * @param error Whatever was thrown.
 * @param context Non-secret hints (`sessionKey`) used to enrich the mapping.
 */
export function toMcpError(
  error: unknown,
  context: { sessionKey?: string } = {},
): McpToolError {
  if (error instanceof McpToolError) return error
  if (error instanceof DaemonError) return mapDaemonError(error)

  const revert = findRevert(error)
  if (revert) {
    const mapped = mapVaultRevert(revert)
    if (mapped) return mapped
  }

  if (looksLikeNoGas(error)) {
    return noGasError(context.sessionKey ?? 'the session key')
  }

  if (error instanceof RpcRetryLimitError) {
    return rateLimitedError(5_000, 'rpc')
  }

  return rpcUnavailableError(error)
}

/* -------------------------------------------------------------------------- */
/* Wire shape                                                                 */
/* -------------------------------------------------------------------------- */

/** The failure payload every tool returns. Redacted like any other result. */
export interface McpErrorPayload {
  ok: false
  error: {
    code: McpErrorCode
    message: string
    retryable: boolean
    details?: Record<string, unknown>
  }
}

/** Render an {@link McpToolError} as the structured result an agent receives. */
export function toErrorPayload(error: McpToolError): McpErrorPayload {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(Object.keys(error.details).length > 0
        ? { details: error.details as Record<string, unknown> }
        : {}),
    },
  }
}

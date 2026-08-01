import { describe, expect, test } from 'bun:test'
import {
  ContractFunctionRevertedError,
  encodeErrorResult,
  type Address,
  type Hex,
} from 'viem'

import { cardVaultAbi } from '../chain/cardVaultAbi.js'
import { RpcRetryLimitError } from '../chain/clients.js'
import {
  ApprovalRequestExpiredError,
  ApprovalRequestNotFoundError,
  DaemonError,
  RateLimitExceededError,
  SqliteUnavailableError,
} from '../daemon/errors.js'
import {
  McpToolError,
  UNKNOWN_ERROR_MESSAGE,
  approvalPendingError,
  cardAlreadyUsedError,
  insufficientAvailableBalanceError,
  mapVaultRevert,
  merchantOutOfScopeError,
  merchantRefusalError,
  noGasError,
  rateLimitedError,
  rpcUnavailableError,
  sessionKeyRevokedError,
  toErrorPayload,
  toMcpError,
  type McpErrorCode,
} from './errors.js'
import { redactToJson } from './redact.js'

const OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
const SESSION = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address
const MERCHANT = '0x90F79bf6EB2c4f870365E785982E1f101E93b906' as Address

/** Build the revert error viem produces for a decodable custom error. */
function revert(errorName: string, args: readonly unknown[]) {
  return new ContractFunctionRevertedError({
    abi: cardVaultAbi,
    data: encodeErrorResult({
      abi: cardVaultAbi,
      errorName: errorName as never,
      args: args as never,
    }) as Hex,
    functionName: 'mintCard',
  })
}

/** Wrap a revert the way viem nests it under a call error. */
function wrapped(errorName: string, args: readonly unknown[]): Error {
  const error = new Error('The contract function reverted.') as Error & {
    cause?: unknown
  }
  error.cause = revert(errorName, args)
  return error
}

describe('mapVaultRevert', () => {
  const cases: [string, readonly unknown[], McpErrorCode][] = [
    ['SessionKeyNotActive', [OWNER, SESSION], 'SESSION_KEY_REVOKED'],
    [
      'InsufficientAvailableBalance',
      [100n, 500n],
      'INSUFFICIENT_AVAILABLE_BALANCE',
    ],
    ['MerchantNotAllowed', [OWNER, SESSION, MERCHANT], 'MERCHANT_OUT_OF_SCOPE'],
    ['MerchantScopeMismatch', [1n, SESSION, MERCHANT], 'MERCHANT_OUT_OF_SCOPE'],
    ['CardNotActive', [1n, 2], 'CARD_ALREADY_USED'],
    ['CardNotActive', [1n, 4], 'CARD_NOT_ACTIVE'],
    ['CardNotActive', [1n, 0], 'CARD_NOT_FOUND'],
    ['CardExpired', [1n, 99n], 'CARD_EXPIRED'],
    ['NotCardOwner', [1n, SESSION, OWNER], 'OWNER_ACTION_REQUIRED'],
    ['CapPerCardExceeded', [500n, 100n], 'INVALID_REQUEST'],
    ['DailyCapExceeded', [500n, 100n], 'INVALID_REQUEST'],
    ['ExpiryTooFar', [99n, 50n], 'INVALID_REQUEST'],
    ['ExpiryInPast', [1n], 'INVALID_REQUEST'],
    ['ChargeExceedsCap', [500n, 100n], 'INVALID_REQUEST'],
    ['ApprovalAlreadyUsed', [OWNER, `0x${'ab'.repeat(32)}`], 'INVALID_REQUEST'],
    ['ZeroAmount', [], 'INVALID_REQUEST'],
  ]

  for (const [errorName, args, code] of cases) {
    test(`${errorName} → ${code}`, () => {
      expect(mapVaultRevert(revert(errorName, args))?.code).toBe(code)
    })
  }

  test('AE3 and a cancelled card are told apart, not merged', () => {
    // "already spent" and "cancelled" call for completely different agent
    // behaviour, so `CardNotActive` cannot map to one code.
    expect(mapVaultRevert(revert('CardNotActive', [1n, 2]))?.code).toBe(
      'CARD_ALREADY_USED',
    )
    expect(mapVaultRevert(revert('CardNotActive', [1n, 4]))?.code).toBe(
      'CARD_NOT_ACTIVE',
    )
  })

  test('AE5 carries the numbers the agent needs to size a retry', () => {
    const mapped = mapVaultRevert(
      revert('InsufficientAvailableBalance', [100n, 500n]),
    )
    expect(mapped?.details).toMatchObject({
      available: '100',
      required: '500',
    })
  })

  test('an unrecognised revert falls through to the safe generic', () => {
    // `InvalidSignature` has no specific agent advice; returning null makes the
    // caller use the generic rather than quoting raw revert data.
    expect(mapVaultRevert(revert('InvalidSignature', []))).toBeNull()
  })
})

describe('toMcpError', () => {
  test('passes an already-classified error through untouched', () => {
    const original = new McpToolError('NO_GAS', 'no gas')
    expect(toMcpError(original)).toBe(original)
  })

  test('finds a revert nested under a viem call error', () => {
    expect(toMcpError(wrapped('SessionKeyNotActive', [OWNER, SESSION])).code).toBe(
      'SESSION_KEY_REVOKED',
    )
  })

  test('maps the daemon rate limit onto RATE_LIMITED', () => {
    const mapped = toMcpError(
      new RateLimitExceededError(SESSION, 20, 3_600_000, 42_000),
    )
    expect(mapped.code).toBe('RATE_LIMITED')
    expect(mapped.retryable).toBe(true)
    expect(mapped.message).toContain('42s')
  })

  test('maps a missing approval request onto APPROVAL_NOT_FOUND', () => {
    expect(toMcpError(new ApprovalRequestNotFoundError('x')).code).toBe(
      'APPROVAL_NOT_FOUND',
    )
  })

  test('maps an expired approval request onto APPROVAL_EXPIRED', () => {
    expect(toMcpError(new ApprovalRequestExpiredError('x', 1)).code).toBe(
      'APPROVAL_EXPIRED',
    )
  })

  test('daemon plumbing the agent cannot act on becomes the generic', () => {
    const mapped = toMcpError(new SqliteUnavailableError())
    expect(mapped.code).toBe('RPC_UNAVAILABLE')
    // Actionable for the human relaying it, without quoting the driver error.
    expect(mapped.message).toContain('giwacard daemon')
  })

  test('recognises gas exhaustion from node prose', () => {
    const mapped = toMcpError(
      new Error('insufficient funds for gas * price + value'),
      { sessionKey: SESSION },
    )
    expect(mapped.code).toBe('NO_GAS')
    expect(mapped.message).toContain(SESSION)
    expect(mapped.message).toContain('faucet')
  })

  test('maps an exhausted retry budget onto RATE_LIMITED', () => {
    expect(
      toMcpError(new RpcRetryLimitError('gave up', { attempts: 4 })).code,
    ).toBe('RATE_LIMITED')
  })

  test('an unclassified failure returns the fixed generic message', () => {
    const mapped = toMcpError(
      new Error('ETIMEDOUT https://user:hunter2@rpc.internal/v1 at Socket.foo'),
    )
    expect(mapped.code).toBe('RPC_UNAVAILABLE')
    expect(mapped.message).toBe(UNKNOWN_ERROR_MESSAGE)
  })

  test('the generic never quotes the underlying error into the payload', () => {
    // The whole point of a generic: an unclassified error is exactly the case
    // where we do not know what the text contains.
    const secret = `0x${'de'.repeat(32)}`
    const payload = toErrorPayload(
      toMcpError(new Error(`rpc rejected key ${secret}`)),
    )
    const serialized = redactToJson(payload)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('rpc rejected')
  })

  test('handles a thrown non-Error without crashing', () => {
    expect(toMcpError('just a string').code).toBe('RPC_UNAVAILABLE')
    expect(toMcpError(undefined).code).toBe('RPC_UNAVAILABLE')
  })

  test('an unknown daemon code still produces a usable error', () => {
    const mapped = toMcpError(
      new DaemonError('DAEMON_CSRF_TOKEN_INVALID', 'bad token'),
    )
    expect(mapped.code).toBe('RPC_UNAVAILABLE')
  })
})

/* -------------------------------------------------------------------------- */
/* Every command an error names must exist                                    */
/* -------------------------------------------------------------------------- */

/**
 * The commands `giwacard` actually routes.
 *
 * Mirrors the switch in `src/cli/index.ts` plus the two lazy paths in
 * `src/cli.ts`. An error message is an instruction a human will type; naming a
 * command nobody built turns a recoverable failure into a dead end, and the
 * human cannot tell the difference from the message.
 */
const REAL_CLI_COMMANDS: ReadonlySet<string> = new Set([
  'init',
  'status',
  'approve',
  'revoke',
  'faucet',
  'daemon',
  'mcp',
  'help',
])

/** Commands named inside backticks, which is how every message spells them. */
function commandsNamedIn(text: string): string[] {
  return [...text.matchAll(/`giwacard ([a-z-]+)/g)].map(
    (match) => match[1] as string,
  )
}

/** One message from every constructor and every mapping branch in the module. */
function everyAgentFacingMessage(): string[] {
  const messages: string[] = [
    noGasError(SESSION).message,
    rateLimitedError(42_000, 'approvals').message,
    rateLimitedError(42_000, 'rpc').message,
    approvalPendingError('appr-1').message,
    cardAlreadyUsedError('7').message,
    insufficientAvailableBalanceError(100n, 500n).message,
    merchantOutOfScopeError(MERCHANT, 'mint').message,
    merchantOutOfScopeError(MERCHANT, 'charge').message,
    sessionKeyRevokedError(SESSION, OWNER).message,
    rpcUnavailableError().message,
    UNKNOWN_ERROR_MESSAGE,
  ]

  // Every decoded vault revert that has specific advice.
  const revertCases: [string, readonly unknown[]][] = [
    ['SessionKeyNotActive', [OWNER, SESSION]],
    ['InsufficientAvailableBalance', [100n, 500n]],
    ['MerchantNotAllowed', [OWNER, SESSION, MERCHANT]],
    ['MerchantScopeMismatch', [1n, SESSION, MERCHANT]],
    ['CardNotActive', [1n, 2]],
    ['CardNotActive', [1n, 4]],
    ['CardNotActive', [1n, 0]],
    ['CardExpired', [1n, 99n]],
    ['NotCardOwner', [1n, SESSION, OWNER]],
    ['CapPerCardExceeded', [500n, 100n]],
    ['DailyCapExceeded', [500n, 100n]],
    ['ExpiryTooFar', [99n, 50n]],
    ['ExpiryInPast', [1n]],
    ['ChargeExceedsCap', [500n, 100n]],
    ['ApprovalAlreadyUsed', [OWNER, `0x${'ab'.repeat(32)}`]],
    ['ZeroAmount', []],
  ]
  for (const [name, args] of revertCases) {
    const mapped = mapVaultRevert(revert(name, args))
    if (mapped) messages.push(mapped.message)
  }

  // Every merchant refusal reason (KTD-9), plus the two unrecognised fallbacks.
  const reasons = [
    'merchant_scope_mismatch',
    'card_already_settled',
    'card_already_used',
    'card_not_active',
    'card_expired',
    'card_cap_too_low',
    'vault_mismatch',
    'unsupported_network',
    'unsupported_scheme',
    'malformed_payment_header',
    'payment_required',
    'settlement_failed',
    'chain_unavailable',
    'no_charge_event',
    'wrong_vault',
    'wrong_merchant',
    'card_id_mismatch',
    'amount_below_price',
    'something_unrecognised',
  ]
  for (const reason of reasons) {
    for (const status of [402, 503]) {
      messages.push(
        merchantRefusalError({ reason, status, cardId: '7', merchant: MERCHANT })
          .message,
      )
    }
  }

  // The daemon codes that surface to an agent.
  messages.push(toMcpError(new SqliteUnavailableError()).message)
  messages.push(
    toMcpError(new RateLimitExceededError(SESSION, 20, 3_600_000, 42_000)).message,
  )
  messages.push(toMcpError(new ApprovalRequestNotFoundError('x')).message)
  messages.push(toMcpError(new ApprovalRequestExpiredError('x', 1)).message)
  messages.push(
    toMcpError(new DaemonError('DAEMON_CSRF_TOKEN_INVALID', 'bad token')).message,
  )

  return messages
}

describe('every command an error names', () => {
  test('exists in the CLI', () => {
    const named = new Set(
      everyAgentFacingMessage().flatMap((message) => commandsNamedIn(message)),
    )
    // Sanity: the scan finds something, so a regex that matched nothing cannot
    // pass this test vacuously.
    expect(named.size).toBeGreaterThan(0)
    for (const command of named) {
      expect(REAL_CLI_COMMANDS).toContain(command)
    }
  })

  test('NO_GAS sends the user to ETH, not to the gUSD faucet', () => {
    // `giwacard faucet` claims gUSD. Recommending it for a gas shortfall sends
    // the user to the wrong asset entirely: the claim succeeds, the balance
    // goes up, and the transaction still cannot be paid for. It is named here
    // only to close off the mistake, so the assertion is that every mention of
    // it is a negation.
    const error = noGasError(SESSION)
    expect(error.message).toMatch(/`giwacard faucet`[^.]*will not fix this/)
    expect(error.message).not.toMatch(/run `giwacard faucet`/)
    expect(error.message).toContain('https://docs.giwa.io/faucets')
    expect(error.message).toContain('ETH is the gas')
    expect(error.details).toMatchObject({ asset: 'ETH' })
  })

  test('AE7 on a mint names the wizard, not a merchants command', () => {
    const message = merchantOutOfScopeError(MERCHANT, 'mint').message
    expect(message).not.toContain('merchants add')
    expect(commandsNamedIn(message)).toEqual(['init'])
    expect(message).toContain('GIWACARD_MERCHANT_ADDRESS')
  })

  test('an owner-only cancel names `giwacard revoke card <id>`', () => {
    const mapped = mapVaultRevert(revert('NotCardOwner', [7n, SESSION, OWNER]))
    expect(mapped?.code).toBe('OWNER_ACTION_REQUIRED')
    expect(mapped?.message).toContain('giwacard revoke card 7')
    expect(mapped?.message).not.toContain('giwacard cancel')
  })
})

describe('toErrorPayload', () => {
  test('is the shape an agent branches on', () => {
    const payload = toErrorPayload(
      new McpToolError('CARD_ALREADY_USED', 'spent', {
        details: { cardId: '3' },
      }),
    )
    expect(payload).toEqual({
      ok: false,
      error: {
        code: 'CARD_ALREADY_USED',
        message: 'spent',
        retryable: false,
        details: { cardId: '3' },
      },
    })
  })

  test('omits empty details rather than emitting an empty object', () => {
    const payload = toErrorPayload(new McpToolError('NO_GAS', 'no gas'))
    expect('details' in payload.error).toBe(false)
  })
})

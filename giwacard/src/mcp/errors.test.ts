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
  mapVaultRevert,
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

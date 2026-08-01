import { describe, expect, test } from 'bun:test'

import { DaemonError } from '../daemon/errors.js'
import { DAEMON_TOKEN_HEADER } from '../daemon/server.js'
import { OwnerDaemonClient, toCliDaemonError } from './daemon.js'
import { CliError } from './errors.js'

/**
 * The owner's daemon client.
 *
 * No socket is bound anywhere here: `connect` and `fetch` are both injected, so
 * the tests exercise the request shaping, the CSRF header, the 403 re-resolve
 * and the error mapping without a daemon process existing.
 */

const CONNECTION = {
  url: 'http://127.0.0.1:47612',
  port: 47612,
  token: 'token-abc',
  pid: 1234,
  version: '0.0.1',
  started: false,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface Call {
  url: string
  init: RequestInit | undefined
}

function client(
  handler: (call: Call, index: number) => Response,
): { client: OwnerDaemonClient; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    client: new OwnerDaemonClient({
      connect: async () => CONNECTION,
      fetch: async (url, init) => {
        const call = { url, init }
        calls.push(call)
        return handler(call, calls.length - 1)
      },
    }),
  }
}

describe('requests', () => {
  test('list sends the CSRF token and the status filter', async () => {
    const { client: owner, calls } = client(() =>
      jsonResponse({ requests: [], count: 0 }),
    )

    const result = await owner.list({ status: 'pending', limit: 25 })
    expect(result.count).toBe(0)

    const call = calls[0]
    expect(call?.url).toContain('/v1/requests?status=pending&limit=25')
    const headers = call?.init?.headers as Record<string, string>
    expect(headers[DAEMON_TOKEN_HEADER]).toBe('token-abc')
  })

  test('list defaults to pending — the owner review list', async () => {
    const { client: owner, calls } = client(() =>
      jsonResponse({ requests: [], count: 0 }),
    )
    await owner.list()
    expect(calls[0]?.url).toContain('status=pending')
  })

  test('resolve posts the decision, the signature and the signed terms', async () => {
    const { client: owner, calls } = client(() => jsonResponse({ id: 'r1' }))

    await owner.resolve('r1', {
      decision: 'approve',
      ownerSignature: '0xabc',
      ownerAddress: '0xowner',
      approvedRequest: { cap: '1' },
    })

    const call = calls[0]
    expect(call?.url).toContain('/v1/requests/r1/resolve')
    expect(call?.init?.method).toBe('POST')
    const body = JSON.parse(call?.init?.body as string) as Record<string, unknown>
    expect(body['decision']).toBe('approve')
    expect(body['ownerSignature']).toBe('0xabc')
    expect(body['approvedRequest']).toEqual({ cap: '1' })
  })

  test('ids are URL-encoded', async () => {
    const { client: owner, calls } = client(() => jsonResponse({}))
    await owner.get('a/b c')
    expect(calls[0]?.url).toContain('/v1/requests/a%2Fb%20c')
  })

  test('a 403 re-resolves the connection exactly once', async () => {
    let attempts = 0
    const { client: owner, calls } = client(() => {
      attempts++
      return attempts === 1
        ? jsonResponse({ error: { code: 'DAEMON_CSRF_TOKEN_INVALID' } }, 403)
        : jsonResponse({ requests: [], count: 0 })
    })

    await owner.list()
    expect(calls).toHaveLength(2)
  })

  test('a second 403 is a real authorisation failure', async () => {
    const { client: owner, calls } = client(() =>
      jsonResponse(
        { error: { code: 'DAEMON_CSRF_TOKEN_INVALID', message: 'Invalid daemon token.' } },
        403,
      ),
    )

    await expect(owner.list()).rejects.toBeInstanceOf(CliError)
    expect(calls).toHaveLength(2)
  })

  test('a transport failure becomes DAEMON_UNAVAILABLE with a start hint', async () => {
    const owner = new OwnerDaemonClient({
      connect: async () => CONNECTION,
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      },
    })

    const error = (await owner.list().catch((caught: unknown) => caught)) as CliError
    expect(error).toBeInstanceOf(CliError)
    expect(error.code).toBe('DAEMON_UNAVAILABLE')
    expect(error.hint).toContain('giwacard daemon')
  })
})

describe('error mapping', () => {
  test('an already-resolved request is its own state, not a generic failure', () => {
    const error = toCliDaemonError(
      new DaemonError(
        'APPROVAL_REQUEST_ALREADY_RESOLVED',
        'Approval request r1 is already approved and cannot be resolved again.',
        { httpStatus: 409 },
      ),
    )
    expect(error.code).toBe('ALREADY_RESOLVED')
    expect(error.message).toContain('already approved')
    expect(error.hint).toContain('giwacard approve')
  })

  test('an expired request explains that expiry is terminal', () => {
    const error = toCliDaemonError(
      new DaemonError('APPROVAL_REQUEST_EXPIRED', 'Approval request r1 expired.', {
        httpStatus: 409,
      }),
    )
    expect(error.code).toBe('ALREADY_RESOLVED')
    expect(error.message).toContain('Expiry is terminal')
    expect(error.hint).toContain('Nothing was signed')
  })

  test('a missing request is NOT_FOUND', () => {
    const error = toCliDaemonError(
      new DaemonError('APPROVAL_REQUEST_NOT_FOUND', 'No approval request with id r1.', {
        httpStatus: 404,
      }),
    )
    expect(error.code).toBe('NOT_FOUND')
  })

  test('daemon plumbing failures are DAEMON_UNAVAILABLE, not leaked internals', () => {
    const error = toCliDaemonError(
      new DaemonError('DAEMON_SQLITE_UNAVAILABLE', 'no sqlite driver anywhere'),
    )
    expect(error.code).toBe('DAEMON_UNAVAILABLE')
    expect(error.message).not.toContain('sqlite')
    expect(error.retryable).toBe(true)
  })

  test('an already-classified CliError passes through unchanged', () => {
    const original = new CliError('NOT_FOUND', 'gone')
    expect(toCliDaemonError(original)).toBe(original)
  })
})

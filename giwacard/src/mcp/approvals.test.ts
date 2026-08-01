import { describe, expect, test } from 'bun:test'

import type { DaemonConnection } from '../daemon/autostart.js'
import { DaemonError } from '../daemon/errors.js'
import { DAEMON_TOKEN_HEADER } from '../daemon/server.js'
import { HttpApprovalClient, type ApprovalRecordWire } from './approvals.js'

/**
 * The seam between the MCP server and the local approval daemon.
 *
 * Driven with an injected `fetch` and an injected `connect`, so nothing here
 * binds a socket or starts a process — the auto-start path itself is covered
 * end to end in `./server.test.ts`.
 */

const SESSION = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'

function record(overrides: Partial<ApprovalRecordWire> = {}): ApprovalRecordWire {
  return {
    id: 'appr-1',
    sessionKey: SESSION,
    agent: null,
    status: 'pending',
    reason: null,
    request: {},
    idempotencyKey: null,
    createdAt: 0,
    expiresAt: 1,
    resolvedAt: null,
    resolvedBy: null,
    decisionNote: null,
    ownerSignature: null,
    signatureConsumedAt: null,
    cardId: null,
    mintTxHash: null,
    signatureConsumed: false,
    terminal: false,
    ...overrides,
  }
}

function connection(token = 'token-1'): DaemonConnection {
  return {
    url: 'http://127.0.0.1:47612',
    port: 47612,
    token,
    pid: 1,
    version: '0.0.1',
    started: false,
  }
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

describe('HttpApprovalClient.create', () => {
  test('reports created=true when the daemon answers 201', async () => {
    const client = new HttpApprovalClient({
      connect: async () => connection(),
      fetch: async () => jsonResponse(record(), 201),
    })

    const outcome = await client.create({ sessionKey: SESSION, request: {} })
    expect(outcome.created).toBe(true)
    expect(outcome.record.id).toBe('appr-1')
  })

  test('reports created=false on an idempotent replay (200)', async () => {
    // This distinction is the whole reason `create` returns an outcome rather
    // than a record: it is what turns a retry loop into APPROVAL_PENDING.
    const client = new HttpApprovalClient({
      connect: async () => connection(),
      fetch: async () => jsonResponse(record(), 200),
    })

    const outcome = await client.create({ sessionKey: SESSION, request: {} })
    expect(outcome.created).toBe(false)
  })

  test('sends the CSRF token and a JSON content type', async () => {
    const calls: Call[] = []
    const client = new HttpApprovalClient({
      connect: async () => connection('secret-token'),
      fetch: async (url, init) => {
        calls.push({ url, init })
        return jsonResponse(record(), 201)
      },
    })

    await client.create({
      sessionKey: SESSION,
      request: { cap: '1' },
      idempotencyKey: 'k1',
    })

    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(calls[0]?.url).toBe('http://127.0.0.1:47612/v1/requests')
    expect(headers[DAEMON_TOKEN_HEADER]).toBe('secret-token')
    expect(headers['content-type']).toBe('application/json')
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      sessionKey: SESSION,
      request: { cap: '1' },
      idempotencyKey: 'k1',
    })
  })
})

describe('HttpApprovalClient error handling', () => {
  test('preserves the daemon error code across the HTTP boundary', async () => {
    // Keeping the code intact is what lets `toMcpError` hold one mapping table
    // instead of two.
    const client = new HttpApprovalClient({
      connect: async () => connection(),
      fetch: async () =>
        jsonResponse(
          {
            error: {
              code: 'APPROVAL_RATE_LIMITED',
              message: 'slow down',
              details: { retryAfterMs: 5000 },
            },
          },
          429,
        ),
    })

    const error = (await client
      .create({ sessionKey: SESSION, request: {} })
      .catch((caught: unknown) => caught)) as DaemonError

    expect(error).toBeInstanceOf(DaemonError)
    expect(error.code).toBe('APPROVAL_RATE_LIMITED')
    expect(error.details['retryAfterMs']).toBe(5000)
  })

  test('a non-JSON error body still produces a typed error', async () => {
    const client = new HttpApprovalClient({
      connect: async () => connection(),
      fetch: async () => new Response('<html>gateway</html>', { status: 502 }),
    })

    const error = (await client.get('x').catch((caught: unknown) => caught)) as DaemonError
    expect(error).toBeInstanceOf(DaemonError)
    expect(error.message).toContain('502')
  })

  test('a transport failure resets the cached connection', async () => {
    let connects = 0
    const client = new HttpApprovalClient({
      connect: async () => {
        connects += 1
        return connection()
      },
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      },
    })

    await client.get('x').catch(() => undefined)
    await client.get('x').catch(() => undefined)

    // A daemon that went away must be re-resolved, not remembered as dead.
    expect(connects).toBe(2)
  })

  test('retries once with a fresh connection after a 403', async () => {
    // The daemon restarts and rotates its token; a cached token starts failing.
    let connects = 0
    let attempts = 0
    const client = new HttpApprovalClient({
      connect: async () => {
        connects += 1
        return connection(`token-${connects}`)
      },
      fetch: async (_url, init) => {
        attempts += 1
        const headers = init?.headers as Record<string, string>
        if (headers[DAEMON_TOKEN_HEADER] === 'token-1') {
          return jsonResponse(
            { error: { code: 'DAEMON_CSRF_TOKEN_INVALID', message: 'no' } },
            403,
          )
        }
        return jsonResponse(record())
      },
    })

    const result = await client.get('appr-1')
    expect(result.id).toBe('appr-1')
    expect(attempts).toBe(2)
    expect(connects).toBe(2)
  })

  test('a second 403 is a real authorisation failure, not an infinite retry', async () => {
    let attempts = 0
    const client = new HttpApprovalClient({
      connect: async () => connection(),
      fetch: async () => {
        attempts += 1
        return jsonResponse(
          { error: { code: 'DAEMON_CSRF_TOKEN_INVALID', message: 'no' } },
          403,
        )
      },
    })

    await expect(client.get('appr-1')).rejects.toBeInstanceOf(DaemonError)
    expect(attempts).toBe(2)
  })
})

describe('HttpApprovalClient connection caching', () => {
  test('resolves the daemon once and reuses it', async () => {
    let connects = 0
    const client = new HttpApprovalClient({
      connect: async () => {
        connects += 1
        return connection()
      },
      fetch: async () => jsonResponse(record()),
    })

    await client.get('a')
    await client.get('b')
    await client.markConsumed('a', { cardId: '1' })

    expect(connects).toBe(1)
  })

  test('a failed start is not cached as a permanent failure', async () => {
    let connects = 0
    const client = new HttpApprovalClient({
      connect: async () => {
        connects += 1
        if (connects === 1) throw new Error('start failed')
        return connection()
      },
      fetch: async () => jsonResponse(record()),
    })

    await expect(client.get('a')).rejects.toThrow('start failed')
    // The user may have fixed things; the next call must try again.
    await expect(client.get('a')).resolves.toMatchObject({ id: 'appr-1' })
    expect(connects).toBe(2)
  })

  test('markConsumed posts the card id the mint produced', async () => {
    const calls: Call[] = []
    const client = new HttpApprovalClient({
      connect: async () => connection(),
      fetch: async (url, init) => {
        calls.push({ url, init })
        return jsonResponse(record({ cardId: '7' }))
      },
    })

    await client.markConsumed('appr-1', { cardId: '7', mintTxHash: null })
    expect(calls[0]?.url).toBe(
      'http://127.0.0.1:47612/v1/requests/appr-1/consume',
    )
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      cardId: '7',
      mintTxHash: null,
    })
  })
})

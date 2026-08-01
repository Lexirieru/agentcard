import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

import { DAEMON_FILE_MODE, daemonInfoPath, daemonTokenPath, fileMode } from './db.js'
import { DaemonBindError } from './errors.js'
import {
  DAEMON_SERVICE_NAME,
  DAEMON_TOKEN_HEADER,
  DEFAULT_DAEMON_PORT,
  allowedOriginsFromEnv,
  loopbackOrigins,
  normalizeOrigin,
  startDaemon,
  type DaemonHandle,
  type StartDaemonOptions,
} from './server.js'

const SESSION_A = '0x1111111111111111111111111111111111111111'
const OWNER = '0x3333333333333333333333333333333333333333'
const SIGNATURE = `0x${'ab'.repeat(65)}`

const OVER_POLICY = {
  token: '0x4444444444444444444444444444444444444444',
  cap: '250000000',
  merchant: '0x5555555555555555555555555555555555555555',
}

let dir: string
let daemon: DaemonHandle

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'giwacard-daemon-server-'))
  daemon = await startDaemon({ dir, port: 0 })
})

afterEach(async () => {
  await daemon.stop()
  rmSync(dir, { recursive: true, force: true })
})

/** Restart the daemon with different options for a single test. */
async function restart(options: StartDaemonOptions): Promise<DaemonHandle> {
  await daemon.stop()
  daemon = await startDaemon({ dir, port: 0, ...options })
  return daemon
}

interface CallOptions {
  method?: string
  body?: unknown
  token?: string | null
  origin?: string
  headers?: Record<string, string>
  contentType?: string | null
}

async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers }
  const token = options.token === undefined ? daemon.token : options.token
  if (token !== null) headers[DAEMON_TOKEN_HEADER] = token
  if (options.origin !== undefined) headers['origin'] = options.origin
  if (options.body !== undefined) {
    const contentType =
      options.contentType === undefined ? 'application/json' : options.contentType
    if (contentType !== null) headers['content-type'] = contentType
  }
  return fetch(`${daemon.url}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(options.body === undefined
      ? {}
      : { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }),
  })
}

async function createRequest(
  extra: Record<string, unknown> = {},
  options: CallOptions = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await call('/v1/requests', {
    body: {
      sessionKey: SESSION_A,
      request: OVER_POLICY,
      reason: 'cap exceeds session policy',
      agent: 'claude-code',
      ...extra,
    },
    ...options,
  })
  return { response, body: (await response.json()) as Record<string, unknown> }
}

/* -------------------------------------------------------------------------- */

describe('bind hardening (KTD-16)', () => {
  test('binds 127.0.0.1, never a wildcard address', () => {
    expect(daemon.hostname).toBe('127.0.0.1')
    expect(daemon.address.address).toBe('127.0.0.1')
    expect(daemon.address.address).not.toBe('0.0.0.0')
    expect(daemon.url).toBe(`http://127.0.0.1:${daemon.port}`)
  })

  test('refuses to bind 0.0.0.0 or any other non-loopback host', async () => {
    for (const hostname of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
      await expect(startDaemon({ dir, port: 0, hostname })).rejects.toThrow(
        DaemonBindError,
      )
    }
  })

  test('the refusal names the offending host and stays a typed error', async () => {
    try {
      await startDaemon({ dir, port: 0, hostname: '0.0.0.0' })
      throw new Error('expected a bind refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(DaemonBindError)
      expect((error as DaemonBindError).code).toBe('DAEMON_BIND_REFUSED')
      expect((error as DaemonBindError).message).toContain('0.0.0.0')
    }
  })

  test('is not reachable on a non-loopback address of this host', async () => {
    const external = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .find((entry) => entry.family === 'IPv4' && !entry.internal)

    if (external === undefined) return // no external interface to test against

    const reachable = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: external.address, port: daemon.port })
      const settle = (value: boolean) => {
        socket.destroy()
        resolve(value)
      }
      socket.setTimeout(2_000)
      socket.once('connect', () => settle(true))
      socket.once('error', () => settle(false))
      socket.once('timeout', () => settle(false))
    })

    expect(reachable).toBe(false)
  })

  test('the default port is fixed so callers can find the daemon', () => {
    expect(DEFAULT_DAEMON_PORT).toBe(47612)
  })
})

describe('runtime files', () => {
  test('publishes the token and the port as 0600 files', () => {
    expect(fileMode(daemonTokenPath({ dir }))).toBe(DAEMON_FILE_MODE)
    expect(fileMode(daemonInfoPath({ dir }))).toBe(DAEMON_FILE_MODE)
  })

  test('the token file holds exactly the token the daemon expects', async () => {
    const { readSecretFile } = await import('./db.js')
    expect(readSecretFile(daemonTokenPath({ dir }))?.trim()).toBe(daemon.token)
    expect(daemon.token).toMatch(/^[0-9a-f]{64}$/)
  })

  test('a fresh token is minted per session', async () => {
    const first = daemon.token
    await restart({})
    expect(daemon.token).not.toBe(first)
  })

  test('stopping removes the runtime files, so nothing stale is advertised', async () => {
    await daemon.stop()
    expect(fileMode(daemonTokenPath({ dir }))).toBeNull()
    expect(fileMode(daemonInfoPath({ dir }))).toBeNull()
    daemon = await startDaemon({ dir, port: 0 })
  })
})

describe('health', () => {
  test('is reachable without a token so auto-start can probe it', async () => {
    const response = await fetch(`${daemon.url}/health`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body['service']).toBe(DAEMON_SERVICE_NAME)
    expect(body['status']).toBe('ok')
    expect(body['pid']).toBe(process.pid)
  })

  test('leaks nothing secret', async () => {
    const body = await (await fetch(`${daemon.url}/health`)).text()
    expect(body).not.toContain(daemon.token)
  })
})

describe('CSRF token guard (KTD-16)', () => {
  test('resolve without a token is rejected', async () => {
    const { body } = await createRequest()
    const response = await call(`/v1/requests/${body['id'] as string}/resolve`, {
      body: { decision: 'approve', ownerSignature: SIGNATURE },
      token: null,
    })
    expect(response.status).toBe(403)
    const error = (await response.json()) as { error: { code: string } }
    expect(error.error.code).toBe('DAEMON_CSRF_TOKEN_INVALID')
  })

  test('resolve with the wrong token is rejected', async () => {
    const { body } = await createRequest()
    const response = await call(`/v1/requests/${body['id'] as string}/resolve`, {
      body: { decision: 'approve', ownerSignature: SIGNATURE },
      token: 'f'.repeat(64),
    })
    expect(response.status).toBe(403)
  })

  test('the request stays pending after a rejected resolve', async () => {
    const { body } = await createRequest()
    const id = body['id'] as string
    await call(`/v1/requests/${id}/resolve`, {
      body: { decision: 'approve', ownerSignature: SIGNATURE },
      token: null,
    })
    const after = (await (await call(`/v1/requests/${id}`)).json()) as Record<
      string,
      unknown
    >
    expect(after['status']).toBe('pending')
  })

  test('create without a token is rejected', async () => {
    const { response } = await createRequest({}, { token: null })
    expect(response.status).toBe(403)
  })

  test('reads are protected too — a page must not enumerate the queue', async () => {
    expect((await call('/v1/requests', { token: null })).status).toBe(403)
    expect((await call('/v1/meta', { token: null })).status).toBe(403)
  })

  test('accepts the token as a bearer credential as well', async () => {
    const response = await call('/v1/requests', {
      token: null,
      headers: { authorization: `Bearer ${daemon.token}` },
    })
    expect(response.status).toBe(200)
  })

  test('a token of the wrong length is rejected without leaking timing', async () => {
    expect((await call('/v1/requests', { token: 'short' })).status).toBe(403)
    expect((await call('/v1/requests', { token: `${daemon.token}x` })).status).toBe(403)
  })
})

describe('Origin allowlist (KTD-16)', () => {
  test('a request whose Origin is outside the allowlist is rejected', async () => {
    const { response, body } = await createRequest(
      {},
      { origin: 'https://evil.example' },
    )
    expect(response.status).toBe(403)
    expect((body as { error: { code: string } }).error.code).toBe(
      'DAEMON_ORIGIN_NOT_ALLOWED',
    )
  })

  test('a valid token does not rescue a disallowed origin', async () => {
    const response = await call('/v1/requests', {
      origin: 'http://localhost:5173',
      token: daemon.token,
    })
    expect(response.status).toBe(403)
  })

  test('the opaque origin `null` is rejected', async () => {
    const response = await call('/v1/requests', { origin: 'null' })
    expect(response.status).toBe(403)
  })

  test('the daemon own origin is allowed once the port is known', async () => {
    for (const origin of loopbackOrigins(daemon.port)) {
      const response = await call('/v1/requests', { origin })
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe(origin)
      expect(response.headers.get('vary')).toBe('Origin')
    }
  })

  test('an explicitly configured dashboard origin is allowed', async () => {
    await restart({ allowedOrigins: ['http://localhost:3000/'] })
    const response = await call('/v1/requests', { origin: 'http://localhost:3000' })
    expect(response.status).toBe(200)
  })

  test('a missing Origin is allowed — native clients never send one', async () => {
    const response = await call('/v1/requests')
    expect(response.status).toBe(200)
    // ...but nothing is echoed back, so no page gains read access.
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('never answers with a wildcard ACAO', async () => {
    const response = await call('/v1/requests', {
      origin: `http://127.0.0.1:${daemon.port}`,
    })
    expect(response.headers.get('access-control-allow-origin')).not.toBe('*')
  })

  test('a preflight from a disallowed origin fails, so the real call never fires', async () => {
    const response = await fetch(`${daemon.url}/v1/requests`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': DAEMON_TOKEN_HEADER,
      },
    })
    expect(response.status).toBe(403)
  })

  test('a preflight from an allowed origin succeeds without a token', async () => {
    const origin = `http://localhost:${daemon.port}`
    const response = await fetch(`${daemon.url}/v1/requests`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': DAEMON_TOKEN_HEADER,
      },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(origin)
    expect(
      response.headers.get('access-control-allow-headers')?.toLowerCase(),
    ).toContain(DAEMON_TOKEN_HEADER)
  })

  test('normalizeOrigin makes comparisons case- and slash-insensitive', () => {
    expect(normalizeOrigin('HTTP://LocalHost:3000/')).toBe('http://localhost:3000')
  })

  test('allowedOriginsFromEnv parses the comma-separated override', () => {
    expect(
      allowedOriginsFromEnv({
        GIWACARD_DAEMON_ALLOWED_ORIGINS: 'http://a.test , http://b.test/ ,',
      }),
    ).toEqual(['http://a.test', 'http://b.test'])
    expect(allowedOriginsFromEnv({})).toEqual([])
  })
})

describe('content-type guard', () => {
  test('rejects a body that is not application/json', async () => {
    const response = await call('/v1/requests', {
      body: 'sessionKey=0x1',
      contentType: 'text/plain;charset=UTF-8',
    })
    expect(response.status).toBe(415)
  })

  test('rejects a POST with no content type at all', async () => {
    const response = await call('/v1/requests', {
      body: '{}',
      contentType: null,
    })
    expect(response.status).toBe(415)
  })

  test('rejects malformed JSON with a typed error', async () => {
    const response = await call('/v1/requests', { body: '{not json' })
    expect(response.status).toBe(400)
    const error = (await response.json()) as { error: { code: string } }
    expect(error.error.code).toBe('DAEMON_INVALID_JSON')
  })

  test('rejects a JSON array body', async () => {
    const response = await call('/v1/requests', { body: [] })
    expect(response.status).toBe(400)
  })
})

describe('approval flow', () => {
  test('creating returns 201 and a pending record', async () => {
    const { response, body } = await createRequest()
    expect(response.status).toBe(201)
    expect(body['status']).toBe('pending')
    expect(body['sessionKey']).toBe(SESSION_A)
    expect(body['request']).toEqual(OVER_POLICY)
    expect(body['terminal']).toBe(false)
  })

  test('an idempotency key prevents a retried create from double-queueing', async () => {
    const first = await createRequest({ idempotencyKey: 'mint-1' })
    const second = await createRequest({ idempotencyKey: 'mint-1' })

    expect(first.response.status).toBe(201)
    expect(second.response.status).toBe(200)
    expect(second.body['id']).toBe(first.body['id'])

    const list = (await (await call('/v1/requests')).json()) as { count: number }
    expect(list.count).toBe(1)
  })

  test('the Idempotency-Key header works as well as the body field', async () => {
    const first = await createRequest({}, { headers: { 'idempotency-key': 'h1' } })
    const second = await createRequest({}, { headers: { 'idempotency-key': 'h1' } })
    expect(second.response.status).toBe(200)
    expect(second.body['id']).toBe(first.body['id'])
  })

  test('the owner sees the request in the pending list', async () => {
    const { body } = await createRequest()
    const list = (await (await call('/v1/requests')).json()) as {
      requests: Record<string, unknown>[]
    }
    expect(list.requests).toHaveLength(1)
    expect(list.requests[0]?.['id']).toBe(body['id'])
  })

  test('an approved request status carries what the agent needs to mint', async () => {
    const { body } = await createRequest()
    const id = body['id'] as string

    await call(`/v1/requests/${id}/resolve`, {
      body: {
        decision: 'approve',
        ownerSignature: SIGNATURE,
        ownerAddress: OWNER,
      },
    })

    // The agent that filed this need not have stayed connected: a bare status
    // read is enough to pick the approval up.
    const status = (await (await call(`/v1/requests/${id}`)).json()) as Record<
      string,
      unknown
    >
    expect(status['status']).toBe('approved')
    expect(status['ownerSignature']).toBe(SIGNATURE)
    expect(status['resolvedBy']).toBe(OWNER)
    expect(status['request']).toEqual(OVER_POLICY)
    expect(status['signatureConsumed']).toBe(false)
    expect(status['terminal']).toBe(true)
  })

  test('consuming deletes the signature and records the card', async () => {
    const { body } = await createRequest()
    const id = body['id'] as string
    await call(`/v1/requests/${id}/resolve`, {
      body: { decision: 'approve', ownerSignature: SIGNATURE },
    })
    const consumed = (await (
      await call(`/v1/requests/${id}/consume`, {
        body: { cardId: 'card-42', mintTxHash: `0x${'11'.repeat(32)}` },
      })
    ).json()) as Record<string, unknown>

    expect(consumed['ownerSignature']).toBeNull()
    expect(consumed['signatureConsumed']).toBe(true)
    expect(consumed['cardId']).toBe('card-42')

    const status = (await (await call(`/v1/requests/${id}`)).json()) as Record<
      string,
      unknown
    >
    expect(status['ownerSignature']).toBeNull()
    expect(status['cardId']).toBe('card-42')
  })

  test('deny is terminal over HTTP too', async () => {
    const { body } = await createRequest()
    const id = body['id'] as string

    const denied = await call(`/v1/requests/${id}/resolve`, {
      body: { decision: 'deny', note: 'no' },
    })
    expect(denied.status).toBe(200)

    const retried = await call(`/v1/requests/${id}/resolve`, {
      body: { decision: 'approve', ownerSignature: SIGNATURE },
    })
    expect(retried.status).toBe(409)
    const error = (await retried.json()) as { error: { code: string } }
    expect(error.error.code).toBe('APPROVAL_REQUEST_ALREADY_RESOLVED')
  })

  test('an expired request cannot be resolved over HTTP', async () => {
    let clock = 1_700_000_000_000
    await restart({ now: () => clock, ttlMs: 60_000 })

    const { body } = await createRequest()
    const id = body['id'] as string
    clock += 60_001

    const status = (await (await call(`/v1/requests/${id}`)).json()) as Record<
      string,
      unknown
    >
    expect(status['status']).toBe('expired')

    const response = await call(`/v1/requests/${id}/resolve`, {
      body: { decision: 'approve', ownerSignature: SIGNATURE },
    })
    expect(response.status).toBe(409)
    const error = (await response.json()) as { error: { code: string } }
    expect(error.error.code).toBe('APPROVAL_REQUEST_EXPIRED')
  })

  test('an unknown id is a 404 with a typed code', async () => {
    const response = await call('/v1/requests/does-not-exist')
    expect(response.status).toBe(404)
    const error = (await response.json()) as { error: { code: string } }
    expect(error.error.code).toBe('APPROVAL_REQUEST_NOT_FOUND')
  })

  test('an unknown route is a 404, not a hang', async () => {
    const response = await call('/v1/nope')
    expect(response.status).toBe(404)
    const error = (await response.json()) as { error: { code: string } }
    expect(error.error.code).toBe('DAEMON_NOT_FOUND')
  })

  test('a bad session key is a 400 with the offending field named', async () => {
    const { response, body } = await createRequest({ sessionKey: 'nope' })
    expect(response.status).toBe(400)
    const error = body as { error: { code: string; details?: Record<string, unknown> } }
    expect(error.error.code).toBe('APPROVAL_REQUEST_INVALID')
    expect(error.error.details?.['field']).toBe('sessionKey')
  })

  test('an unknown status filter is a 400', async () => {
    expect((await call('/v1/requests?status=weird')).status).toBe(400)
  })

  test('status filters work over the query string', async () => {
    const { body } = await createRequest()
    await call(`/v1/requests/${body['id'] as string}/resolve`, {
      body: { decision: 'deny' },
    })
    const denied = (await (await call('/v1/requests?status=denied')).json()) as {
      count: number
    }
    expect(denied.count).toBe(1)
    expect(((await (await call('/v1/requests')).json()) as { count: number }).count).toBe(0)
  })
})

describe('rate limiting over HTTP', () => {
  test('the N+1th request is a 429 carrying Retry-After', async () => {
    await restart({ rateLimit: { max: 2, windowMs: 60_000 } })

    expect((await createRequest()).response.status).toBe(201)
    expect((await createRequest()).response.status).toBe(201)

    const { response, body } = await createRequest()
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((body as { error: { code: string } }).error.code).toBe(
      'APPROVAL_RATE_LIMITED',
    )
  })
})

describe('meta', () => {
  test('reports the allowlist, limits and queue stats', async () => {
    await createRequest()
    const meta = (await (await call('/v1/meta')).json()) as Record<string, unknown>
    expect(meta['service']).toBe(DAEMON_SERVICE_NAME)
    expect(meta['allowedOrigins']).toContain(`http://127.0.0.1:${daemon.port}`)
    expect((meta['stats'] as Record<string, number>)['pending']).toBe(1)
    expect((meta['rateLimit'] as Record<string, number>)['max']).toBeGreaterThan(0)
  })
})

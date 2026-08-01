import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

import { VERSION } from '../version.js'
import {
  DAEMON_TOKEN_FILE_NAME,
  daemonInfoPath,
  daemonTokenPath,
  generateDaemonToken,
  openDaemonDatabase,
  removeFileIfPresent,
  writeSecretFile,
  type DaemonHomeOptions,
} from './db.js'
import {
  CsrfTokenError,
  DaemonBindError,
  DaemonError,
  OriginNotAllowedError,
} from './errors.js'
import {
  ApprovalQueue,
  type ApprovalQueueOptions,
  type ApprovalRequestRecord,
  type ApprovalStatus,
} from './queue.js'

/**
 * The local coordinator's HTTP surface (KTD-10) and its hardening (KTD-16).
 *
 * ## Threat model
 *
 * This is a service listening on the owner's own machine. The attack it must
 * survive is the well-known one against localhost dev servers: any page the
 * owner has open in a browser can issue `fetch('http://127.0.0.1:<port>/...')`,
 * and without defences that page could approve an over-policy spend request.
 *
 * Three independent layers stop it:
 *
 * 1. **Loopback-only bind.** Nothing off-host can reach the socket at all;
 *    {@link startDaemon} refuses any non-loopback hostname outright.
 * 2. **Origin allowlist.** Browsers attach `Origin` to every cross-site request
 *    and a page cannot forge or suppress it. An unlisted origin is refused
 *    before the handler runs. A *missing* `Origin` means the caller is not a
 *    browser — the CLI and the MCP server — which is allowed, but still has to
 *    clear layer 3.
 * 3. **Per-session CSRF token.** A 32-byte secret written to
 *    `~/.giwacard/daemon-token` with mode 0600 and required on every `/v1`
 *    request. A web page cannot read that file, and the custom header it would
 *    have to send forces a CORS preflight that the allowlist rejects.
 *
 * The token is also the daemon's whole notion of "the owner": it holds no key
 * and cannot verify signatures, so the authority to approve is exactly the
 * ability to read an 0600 file in the owner's home directory.
 */

/** Default port. High, fixed, and unlikely to collide with a dev server. */
export const DEFAULT_DAEMON_PORT = 47612

/** The only hostnames {@link startDaemon} will bind. */
export const LOOPBACK_HOSTNAMES: readonly string[] = [
  '127.0.0.1',
  'localhost',
  '::1',
]

/** Header carrying the CSRF token. Custom, so it always forces a preflight. */
export const DAEMON_TOKEN_HEADER = 'x-giwacard-token'

/** Marker in `GET /health`, so auto-start can tell our daemon from a stranger. */
export const DAEMON_SERVICE_NAME = 'giwacard-daemon'

/** Largest request body the daemon will read, in bytes. */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* -------------------------------------------------------------------------- */

/** JSON body of `GET /health`. Unauthenticated, so it carries nothing secret. */
export interface DaemonHealth {
  service: typeof DAEMON_SERVICE_NAME
  version: string
  pid: number
  status: 'ok'
}

/** Contents of `~/.giwacard/daemon.json`. No secrets: the token has its own file. */
export interface DaemonInfo {
  pid: number
  port: number
  hostname: string
  url: string
  version: string
  startedAt: number
}

/** JSON error body. `code` is stable; `message` is for humans. */
export interface DaemonErrorBody {
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
}

/* -------------------------------------------------------------------------- */
/* Origin helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Lowercase an origin and drop a trailing slash, so comparisons are exact. */
export function normalizeOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, '')
}

/** The two origins a browser could use to reach this daemon on `port`. */
export function loopbackOrigins(port: number): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`]
}

/**
 * Parse `GIWACARD_DAEMON_ALLOWED_ORIGINS` (comma-separated).
 *
 * The escape hatch for a dashboard served from another local port (U10) without
 * recompiling. Non-loopback entries are kept — the owner asked for them — but
 * they are the only way anything but the daemon's own origin gets in.
 */
export function allowedOriginsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env['GIWACARD_DAEMON_ALLOWED_ORIGINS']
  if (!raw) return []
  return raw
    .split(',')
    .map((entry) => normalizeOrigin(entry))
    .filter((entry) => entry !== '')
}

/* -------------------------------------------------------------------------- */
/* App                                                                        */
/* -------------------------------------------------------------------------- */

export interface DaemonAppOptions {
  queue: ApprovalQueue
  /** The per-session CSRF token clients must present. */
  token: string
  /**
   * Mutable allowlist of origins.
   *
   * A `Set` rather than an array because the daemon's own origin is only known
   * after the socket binds (port 0 picks one), and {@link startDaemon} adds it
   * to this very set once it does.
   */
  allowedOrigins?: Set<string>
  version?: string
}

/** Constant-time token comparison that does not leak length through timing. */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() ?? null
}

function errorBody(error: DaemonError): DaemonErrorBody {
  const details = error.details
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(Object.keys(details).length > 0
        ? { details: details as Record<string, unknown> }
        : {}),
    },
  }
}

/**
 * Layer 2: reject a browser origin that is not on the allowlist.
 *
 * Requests with no `Origin` at all are let through — no browser omits it on a
 * cross-site request, so their absence means a native client, which still has to
 * present the token. Requests with `Origin: null` (sandboxed iframe, `file://`)
 * are refused: an opaque origin can never be on an allowlist.
 */
function originGuard(allowed: Set<string>): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.header('origin')
    const isPreflight = c.req.method === 'OPTIONS'

    if (raw !== undefined && raw.trim() !== '') {
      const origin = normalizeOrigin(raw)
      if (!allowed.has(origin)) throw new OriginNotAllowedError(raw)
      // Echo back only the exact allowlisted origin, never `*`.
      c.header('Access-Control-Allow-Origin', origin)
      c.header('Vary', 'Origin')
    }

    if (isPreflight) {
      // Answered before the token check on purpose: a preflight cannot carry
      // custom headers, so demanding the token here would make every legitimate
      // cross-origin call fail. The preflight itself grants nothing — the real
      // request still has to pass both guards.
      c.header(
        'Access-Control-Allow-Methods',
        'GET, POST, OPTIONS',
      )
      c.header(
        'Access-Control-Allow-Headers',
        `content-type, authorization, ${DAEMON_TOKEN_HEADER}`,
      )
      c.header('Access-Control-Max-Age', '600')
      return c.body(null, 204)
    }

    await next()
  }
}

/** Layer 3: require the 0600 per-session token on every `/v1` request. */
function csrfGuard(token: string): MiddlewareHandler {
  return async (c, next) => {
    const presented =
      c.req.header(DAEMON_TOKEN_HEADER) ??
      bearerToken(c.req.header('authorization'))
    if (presented === null || presented === undefined || presented === '') {
      throw new CsrfTokenError('missing')
    }
    if (!tokensMatch(presented, token)) throw new CsrfTokenError('invalid')
    await next()
  }
}

/**
 * Parse a JSON body, insisting on `application/json`.
 *
 * A cross-site `<form>` post can only produce three content types, none of them
 * JSON, so this rejects the one shape of request that can reach us without a
 * preflight.
 */
async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header('content-type') ?? ''
  if (!/^application\/json\b/i.test(contentType.trim())) {
    throw new DaemonError(
      'DAEMON_UNSUPPORTED_MEDIA_TYPE',
      'Expected Content-Type: application/json.',
      { httpStatus: 415 },
    )
  }
  let parsed: unknown
  try {
    parsed = await c.req.json()
  } catch (cause) {
    throw new DaemonError('DAEMON_INVALID_JSON', 'Request body is not valid JSON.', {
      httpStatus: 400,
      cause,
    })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DaemonError(
      'DAEMON_INVALID_JSON',
      'Request body must be a JSON object.',
      { httpStatus: 400 },
    )
  }
  return parsed as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function parseStatusFilter(raw: string | undefined): ApprovalStatus | 'all' {
  if (raw === undefined || raw === '') return 'pending'
  if (
    raw === 'pending' ||
    raw === 'approved' ||
    raw === 'denied' ||
    raw === 'expired' ||
    raw === 'all'
  ) {
    return raw
  }
  throw new DaemonError(
    'APPROVAL_REQUEST_INVALID',
    `Unknown status filter ${JSON.stringify(raw)}.`,
    { httpStatus: 400 },
  )
}

/**
 * Public projection of a queue record.
 *
 * `ownerSignature` is included because the whole point of the status endpoint is
 * to let a disconnected agent pick up its approval later; `signatureConsumed`
 * distinguishes "never had one" from "already spent and deleted".
 */
export function toApprovalResponse(
  record: ApprovalRequestRecord,
): Record<string, unknown> {
  return {
    ...record,
    signatureConsumed: record.signatureConsumedAt !== null,
    terminal: record.status !== 'pending',
  }
}

/** Build the Hono app. Exported so tests can drive it without a socket. */
export function createDaemonApp(options: DaemonAppOptions): Hono {
  const { queue, token } = options
  const allowed = options.allowedOrigins ?? new Set<string>()
  const version = options.version ?? VERSION
  const app = new Hono()

  app.onError((error, c) => {
    if (error instanceof DaemonError) {
      const body = errorBody(error)
      if (error.code === 'APPROVAL_RATE_LIMITED') {
        const retryAfterMs = Number(error.details['retryAfterMs'] ?? 0)
        c.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
      }
      return c.json(body, error.httpStatus as ContentfulStatusCode)
    }
    // Never surface an unexpected stack to a caller that may be a web page.
    return c.json(
      {
        error: {
          code: 'DAEMON_INTERNAL_ERROR',
          message: 'The giwacard daemon hit an unexpected error.',
        },
      } satisfies DaemonErrorBody,
      500,
    )
  })

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'DAEMON_NOT_FOUND',
          message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}.`,
        },
      } satisfies DaemonErrorBody,
      404,
    ),
  )

  /**
   * Unauthenticated on purpose: auto-start has to identify a listener on the
   * expected port before it can know whether the token file it holds is still
   * the right one. It reveals only that giwacard is running.
   */
  app.get('/health', (c) =>
    c.json({
      service: DAEMON_SERVICE_NAME,
      version,
      pid: process.pid,
      status: 'ok',
    } satisfies DaemonHealth),
  )

  // Both guards cover reads as well as writes. KTD-16 only demands them on
  // state-changing endpoints, but a page that can *read* the queue learns the
  // owner's pending spend requests, so there is no reason to leave that open.
  app.use('/v1/*', originGuard(allowed))
  app.use('/v1/*', csrfGuard(token))

  app.get('/v1/meta', (c) =>
    c.json({
      service: DAEMON_SERVICE_NAME,
      version,
      pid: process.pid,
      allowedOrigins: [...allowed].sort(),
      ttlMs: queue.ttlMs,
      rateLimit: queue.rateLimit,
      stats: queue.stats(),
    }),
  )

  /** Create an over-policy approval request. Used by the MCP server (U5). */
  app.post('/v1/requests', async (c) => {
    const body = await readJsonBody(c)
    const { record, created } = queue.create({
      sessionKey: asString(body['sessionKey']) ?? '',
      request: (body['request'] ?? {}) as Record<string, unknown>,
      reason: asString(body['reason']) ?? null,
      agent: asString(body['agent']) ?? null,
      idempotencyKey:
        asString(body['idempotencyKey']) ??
        c.req.header('idempotency-key') ??
        null,
      ...(typeof body['ttlMs'] === 'number' ? { ttlMs: body['ttlMs'] } : {}),
    })
    // 200 rather than 201 on an idempotent replay, so a retrying client can see
    // that it did not queue a second request.
    return c.json(toApprovalResponse(record), created ? 201 : 200)
  })

  /** The owner's review list. */
  app.get('/v1/requests', (c) => {
    const status = parseStatusFilter(c.req.query('status'))
    const limitRaw = c.req.query('limit')
    const sessionKey = c.req.query('sessionKey')
    const records = queue.list({
      status,
      ...(limitRaw !== undefined ? { limit: Number(limitRaw) } : {}),
      ...(sessionKey !== undefined ? { sessionKey } : {}),
    })
    return c.json({
      requests: records.map(toApprovalResponse),
      count: records.length,
    })
  })

  /**
   * Stateless status check.
   *
   * The agent that filed the request need not still be connected: it polls this
   * later, finds `approved`, takes the signature, and mints.
   */
  app.get('/v1/requests/:id', (c) => {
    const record = queue.get(c.req.param('id'))
    return c.json(toApprovalResponse(record))
  })

  /** Approve or deny. State-changing, so both guards above have run. */
  app.post('/v1/requests/:id/resolve', async (c) => {
    const body = await readJsonBody(c)
    const decision = asString(body['decision'])
    const record = queue.resolve(c.req.param('id'), {
      decision: decision as 'approve' | 'deny',
      ownerSignature: asString(body['ownerSignature']) ?? null,
      ownerAddress: asString(body['ownerAddress']) ?? null,
      note: asString(body['note']) ?? null,
      approvedRequest:
        typeof body['approvedRequest'] === 'object' &&
        body['approvedRequest'] !== null
          ? (body['approvedRequest'] as Record<string, unknown>)
          : null,
    })
    return c.json(toApprovalResponse(record))
  })

  /** Mark the signature spent onchain; the daemon deletes it (KTD-16). */
  app.post('/v1/requests/:id/consume', async (c) => {
    const body = await readJsonBody(c)
    const record = queue.markConsumed(c.req.param('id'), {
      cardId: asString(body['cardId']) ?? null,
      mintTxHash: asString(body['mintTxHash']) ?? null,
    })
    return c.json(toApprovalResponse(record))
  })

  return app
}

/* -------------------------------------------------------------------------- */
/* node:http <-> fetch bridge                                                 */
/* -------------------------------------------------------------------------- */

type FetchHandler = (request: Request) => Response | Promise<Response>

function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_REQUEST_BODY_BYTES) {
        reject(
          new DaemonError('DAEMON_INVALID_JSON', 'Request body is too large.', {
            httpStatus: 413,
          }),
        )
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function toWebRequest(req: IncomingMessage, base: string, body: Buffer): Request {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || key.startsWith(':')) continue
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else headers.set(key, value)
  }
  const method = (req.method ?? 'GET').toUpperCase()
  const hasBody = method !== 'GET' && method !== 'HEAD' && body.length > 0
  const url = new URL(req.url ?? '/', base).toString()
  return new Request(url, {
    method,
    headers,
    ...(hasBody ? { body: new Uint8Array(body) } : {}),
  })
}

async function writeWebResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer())
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return
    headers[key] = value
  })
  const setCookie = response.headers.getSetCookie?.() ?? []
  if (setCookie.length > 0) headers['set-cookie'] = setCookie
  // 204/304 must not carry Content-Length; node rejects a body on them anyway.
  const bodyless = response.status === 204 || response.status === 304
  if (!bodyless) headers['content-length'] = String(body.byteLength)
  res.writeHead(response.status, headers)
  res.end(bodyless ? undefined : body)
}

/**
 * Serve a fetch handler over `node:http`.
 *
 * Hono is runtime-agnostic; this keeps a single, Bun-and-Node-identical serving
 * path (the alternative — `Bun.serve` here, an adapter there — would leave the
 * Node path untested by a Bun test suite).
 */
function serveFetchHandler(handler: FetchHandler): Server {
  return createServer((req, res) => {
    void (async () => {
      const host = req.headers.host ?? '127.0.0.1'
      try {
        const body = await collectBody(req)
        const response = await handler(toWebRequest(req, `http://${host}`, body))
        await writeWebResponse(res, response)
      } catch (error) {
        if (res.headersSent) {
          res.end()
          return
        }
        const daemonError =
          error instanceof DaemonError
            ? error
            : new DaemonError(
                'DAEMON_INTERNAL_ERROR',
                'The giwacard daemon hit an unexpected error.',
              )
        const payload = Buffer.from(JSON.stringify(errorBody(daemonError)), 'utf8')
        res.writeHead(daemonError.httpStatus, {
          'content-type': 'application/json',
          'content-length': String(payload.byteLength),
        })
        res.end(payload)
      }
    })()
  })
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

export interface StartDaemonOptions
  extends DaemonHomeOptions,
    ApprovalQueueOptions {
  /** Port to bind. `0` picks a free one — used throughout the test suite. */
  port?: number
  /** Must be loopback. Present so tests can *prove* the refusal, not to widen it. */
  hostname?: string
  /** Extra browser origins allowed to call `/v1`, on top of the daemon's own. */
  allowedOrigins?: readonly string[]
  /** Explicit database path. Defaults to `~/.giwacard/daemon.db`. */
  dbPath?: string
  /** Reuse an already-open queue instead of opening the database. */
  queue?: ApprovalQueue
  /** Force a specific CSRF token. Defaults to a fresh 32-byte one per session. */
  token?: string
  /** Write `daemon.json` / `daemon-token`. Default true. */
  writeRuntimeFiles?: boolean
  version?: string
}

export interface DaemonHandle {
  url: string
  port: number
  hostname: string
  /** The per-session CSRF token, also written to `~/.giwacard/daemon-token`. */
  token: string
  queue: ApprovalQueue
  app: Hono
  /** Bind address as reported by the OS. Asserted in tests. */
  address: AddressInfo
  stop(): Promise<void>
}

/** Reject anything that is not a loopback literal (KTD-16). */
function assertLoopback(hostname: string): void {
  if (!LOOPBACK_HOSTNAMES.includes(hostname)) {
    throw new DaemonBindError(
      `The giwacard daemon only binds loopback addresses; refusing ${hostname}. ` +
        'It holds the owner\'s approval queue and must never be reachable off-host.',
      { hostname, allowed: LOOPBACK_HOSTNAMES },
    )
  }
}

/**
 * Start the daemon.
 *
 * Opens (or adopts) the queue, binds loopback-only, then publishes the port and
 * a fresh CSRF token into `~/.giwacard/` as 0600 files so the CLI and MCP server
 * can find and authenticate to it.
 */
export async function startDaemon(
  options: StartDaemonOptions = {},
): Promise<DaemonHandle> {
  const hostname = options.hostname ?? '127.0.0.1'
  assertLoopback(hostname)

  const ownsQueue = options.queue === undefined
  const queue =
    options.queue ??
    new ApprovalQueue(
      await openDaemonDatabase({
        ...(options.dir !== undefined ? { dir: options.dir } : {}),
        ...(options.dbPath !== undefined ? { path: options.dbPath } : {}),
      }),
      {
        ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
        ...(options.rateLimit !== undefined ? { rateLimit: options.rateLimit } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      },
    )

  const token = options.token ?? generateDaemonToken()
  const allowedOrigins = new Set<string>([
    ...allowedOriginsFromEnv(),
    ...(options.allowedOrigins ?? []).map(normalizeOrigin),
  ])

  const app = createDaemonApp({
    queue,
    token,
    allowedOrigins,
    ...(options.version !== undefined ? { version: options.version } : {}),
  })

  const server = serveFetchHandler((request) => app.fetch(request))

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        reject(
          new DaemonBindError(
            error.code === 'EADDRINUSE'
              ? `Port ${options.port ?? DEFAULT_DAEMON_PORT} on ${hostname} is already in use.`
              : `Could not bind the giwacard daemon on ${hostname}: ${error.message}`,
            { hostname, port: options.port ?? DEFAULT_DAEMON_PORT },
            error,
          ),
        )
      }
      server.once('error', onError)
      // `exclusive` keeps a second process from silently sharing the socket, so
      // "is it already running?" has one answer.
      server.listen(
        { host: hostname, port: options.port ?? DEFAULT_DAEMON_PORT, exclusive: true },
        () => {
          server.off('error', onError)
          resolve()
        },
      )
    })
  } catch (error) {
    if (ownsQueue) queue.close()
    throw error
  }

  const address = server.address() as AddressInfo
  const port = address.port
  const url = `http://${hostname === '::1' ? '[::1]' : hostname}:${port}`

  // Only now is the port known, so only now can the daemon's own origin join the
  // allowlist (see DaemonAppOptions.allowedOrigins).
  for (const origin of loopbackOrigins(port)) allowedOrigins.add(origin)

  const writeFiles = options.writeRuntimeFiles ?? true
  const homeOptions: DaemonHomeOptions =
    options.dir !== undefined ? { dir: options.dir } : {}

  if (writeFiles) {
    writeSecretFile(daemonTokenPath(homeOptions), `${token}\n`)
    writeSecretFile(
      daemonInfoPath(homeOptions),
      `${JSON.stringify(
        {
          pid: process.pid,
          port,
          hostname,
          url,
          version: options.version ?? VERSION,
          startedAt: Date.now(),
        } satisfies DaemonInfo,
        null,
        2,
      )}\n`,
    )
  }

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
    if (writeFiles) {
      removeFileIfPresent(daemonInfoPath(homeOptions))
      removeFileIfPresent(daemonTokenPath(homeOptions))
    }
    if (ownsQueue) queue.close()
  }

  return { url, port, hostname, token, queue, app, address, stop }
}

/* -------------------------------------------------------------------------- */
/* `giwacard daemon`                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Entry point behind `giwacard daemon`.
 *
 * Blocks until SIGINT/SIGTERM. Resolves with the process exit code.
 */
export async function runDaemonCommand(
  argv: readonly string[] = [],
  io: { stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream } = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr

  const portIndex = argv.indexOf('--port')
  const portArg = portIndex >= 0 ? argv[portIndex + 1] : undefined
  const port =
    portArg !== undefined && Number.isFinite(Number(portArg))
      ? Number(portArg)
      : DEFAULT_DAEMON_PORT

  let handle: DaemonHandle
  try {
    handle = await startDaemon({ port })
  } catch (error) {
    stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 1
  }

  stdout.write(
    [
      `giwacard daemon listening on ${handle.url}`,
      `token: ~/.giwacard/${DAEMON_TOKEN_FILE_NAME} (mode 0600)`,
      'Press Ctrl-C to stop.',
      '',
    ].join('\n'),
  )

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      process.off('SIGINT', shutdown)
      process.off('SIGTERM', shutdown)
      resolve()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })

  await handle.stop()
  return 0
}

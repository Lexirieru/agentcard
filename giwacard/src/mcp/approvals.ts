import {
  ensureDaemonRunning,
  type DaemonConnection,
  type EnsureDaemonOptions,
} from '../daemon/autostart.js'
import { DaemonError, type DaemonErrorCode } from '../daemon/errors.js'
import type { ApprovalStatus } from '../daemon/queue.js'
import { DAEMON_TOKEN_HEADER } from '../daemon/server.js'

/**
 * The MCP server's client for the local approval daemon (KTD-2, KTD-10).
 *
 * The MCP server is the daemon's main writer: every over-policy card request an
 * agent makes is queued here, and every `check_approval_status` poll reads back
 * from here. Two properties of that relationship shape this module.
 *
 * **The daemon is started on demand.** An agent's first tool call must not fail
 * because the user never ran `giwacard daemon`, so the connection is established
 * lazily through {@link ensureDaemonRunning} — the `O_EXCL`-locked auto-start
 * from U8, reused verbatim so concurrent CLI and MCP calls still converge on one
 * daemon process.
 *
 * **The connection is cached, but not trusted forever.** A daemon that was
 * restarted rotates its CSRF token, so a cached connection that starts answering
 * 403 is dropped and re-established once. Beyond that a failure is a real
 * failure.
 */

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* -------------------------------------------------------------------------- */

/**
 * An approval record as the daemon serialises it.
 *
 * `ownerSignature` is on the wire because the daemon has no idea who is asking
 * and the relay needs it. It must never reach an agent — see
 * {@link ApprovalClient.get} and the redaction layer in `redact.ts`.
 */
export interface ApprovalRecordWire {
  id: string
  sessionKey: string
  agent: string | null
  status: ApprovalStatus
  reason: string | null
  request: Record<string, unknown>
  idempotencyKey: string | null
  createdAt: number
  expiresAt: number
  resolvedAt: number | null
  resolvedBy: string | null
  decisionNote: string | null
  ownerSignature: string | null
  signatureConsumedAt: number | null
  cardId: string | null
  mintTxHash: string | null
  signatureConsumed: boolean
  terminal: boolean
}

export interface CreateApprovalInput {
  sessionKey: string
  request: Record<string, unknown>
  reason?: string | null
  agent?: string | null
  idempotencyKey?: string | null
  ttlMs?: number
}

export interface MarkApprovalConsumedInput {
  cardId?: string | null
  mintTxHash?: string | null
}

/** Result of {@link ApprovalClient.create}. */
export interface ApprovalCreateOutcome {
  record: ApprovalRecordWire
  /**
   * `false` when an `idempotencyKey` matched a request that was already queued.
   *
   * This is what lets `mint_card` tell "I have filed your request" from "you
   * are asking again for one that is still pending", and answer the second case
   * with `APPROVAL_PENDING` instead of a duplicate approval_id.
   */
  created: boolean
}

/** Everything the MCP tools need from the approval queue. */
export interface ApprovalClient {
  /** Queue an over-policy request. Never sends a transaction. */
  create(input: CreateApprovalInput): Promise<ApprovalCreateOutcome>
  /** Read one request. Works with no live session — this is the R10b path. */
  get(id: string): Promise<ApprovalRecordWire>
  /** Mark the owner signature spent onchain so the daemon deletes it. */
  markConsumed(
    id: string,
    input: MarkApprovalConsumedInput,
  ): Promise<ApprovalRecordWire>
}

/* -------------------------------------------------------------------------- */
/* HTTP client                                                                */
/* -------------------------------------------------------------------------- */

/** Injected in tests so the suite never binds a socket. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

export interface HttpApprovalClientOptions {
  /** Options forwarded to {@link ensureDaemonRunning}. */
  daemon?: EnsureDaemonOptions
  /** Override the connection entirely; skips auto-start. */
  connect?: () => Promise<DaemonConnection>
  fetch?: FetchLike
  /** Per-request timeout. The daemon is local, so this is generous. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000

interface DaemonErrorWire {
  error?: {
    code?: string
    message?: string
    details?: Record<string, unknown>
  }
}

/**
 * Rebuild a {@link DaemonError} from an error response.
 *
 * Preserving the daemon's own code across the HTTP boundary is what lets
 * `toMcpError` keep one mapping table instead of two: a rate limit hit
 * in-process and a rate limit hit over HTTP arrive at the agent identically.
 */
async function toDaemonError(response: Response): Promise<DaemonError> {
  let body: DaemonErrorWire = {}
  try {
    body = (await response.json()) as DaemonErrorWire
  } catch {
    // A non-JSON error body means something other than the daemon answered.
  }
  const code = body.error?.code
  const message =
    body.error?.message ?? `The giwacard daemon answered ${response.status}.`
  return new DaemonError((code ?? 'DAEMON_INTERNAL_ERROR') as DaemonErrorCode, message, {
    httpStatus: response.status,
    ...(body.error?.details ? { details: body.error.details } : {}),
  })
}

/** {@link ApprovalClient} over the daemon's loopback HTTP API. */
export class HttpApprovalClient implements ApprovalClient {
  readonly #options: HttpApprovalClientOptions
  readonly #fetch: FetchLike
  #connection: Promise<DaemonConnection> | null = null

  constructor(options: HttpApprovalClientOptions = {}) {
    this.#options = options
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
  }

  /** Resolve (and cache) a live daemon, starting one if there is none. */
  async connection(): Promise<DaemonConnection> {
    if (this.#connection === null) {
      const connect =
        this.#options.connect ??
        (() => ensureDaemonRunning(this.#options.daemon ?? {}))
      this.#connection = connect().catch((error: unknown) => {
        // A failed start must not poison the cache: the next tool call should
        // get a fresh attempt, not a permanently rejected promise.
        this.#connection = null
        throw error
      })
    }
    return this.#connection
  }

  /** Drop the cached connection, e.g. after the daemon rotated its token. */
  reset(): void {
    this.#connection = null
  }

  async #request<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
    retryOnAuthFailure = true,
  ): Promise<T> {
    return (await this.#requestWithStatus<T>(path, init, retryOnAuthFailure)).body
  }

  async #requestWithStatus<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
    retryOnAuthFailure = true,
  ): Promise<{ body: T; status: number }> {
    const connection = await this.connection()
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )

    let response: Response
    try {
      response = await this.#fetch(`${connection.url}${path}`, {
        method: init.method,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          [DAEMON_TOKEN_HEADER]: connection.token,
          ...(init.body !== undefined
            ? { 'content-type': 'application/json' }
            : {}),
        },
        ...(init.body !== undefined
          ? { body: JSON.stringify(init.body) }
          : {}),
      })
    } catch (cause) {
      this.reset()
      throw new DaemonError(
        'DAEMON_START_FAILED',
        'Could not reach the local giwacard approval daemon.',
        { httpStatus: 503, cause },
      )
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 403 && retryOnAuthFailure) {
      // The daemon restarted and rotated its token while we held a stale one.
      // Re-resolve once; a second 403 is a genuine authorisation failure.
      this.reset()
      return this.#requestWithStatus<T>(path, init, false)
    }

    if (!response.ok) throw await toDaemonError(response)

    return { body: (await response.json()) as T, status: response.status }
  }

  /** @inheritdoc */
  async create(input: CreateApprovalInput): Promise<ApprovalCreateOutcome> {
    // The daemon answers 201 for a freshly queued request and 200 for an
    // idempotent replay — that status is the only place the distinction exists.
    const { body, status } = await this.#requestWithStatus<ApprovalRecordWire>(
      '/v1/requests',
      {
        method: 'POST',
        body: {
          sessionKey: input.sessionKey,
          request: input.request,
          reason: input.reason ?? null,
          agent: input.agent ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
        },
      },
    )
    return { record: body, created: status === 201 }
  }

  /** @inheritdoc */
  async get(id: string): Promise<ApprovalRecordWire> {
    return this.#request<ApprovalRecordWire>(
      `/v1/requests/${encodeURIComponent(id)}`,
      { method: 'GET' },
    )
  }

  /** @inheritdoc */
  async markConsumed(
    id: string,
    input: MarkApprovalConsumedInput,
  ): Promise<ApprovalRecordWire> {
    return this.#request<ApprovalRecordWire>(
      `/v1/requests/${encodeURIComponent(id)}/consume`,
      {
        method: 'POST',
        body: {
          cardId: input.cardId ?? null,
          mintTxHash: input.mintTxHash ?? null,
        },
      },
    )
  }
}

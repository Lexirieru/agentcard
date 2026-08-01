import {
  ensureDaemonRunning,
  type DaemonConnection,
  type EnsureDaemonOptions,
} from '../daemon/autostart.js'
import { DaemonError } from '../daemon/errors.js'
import type { ApprovalStatus } from '../daemon/queue.js'
import { DAEMON_TOKEN_HEADER } from '../daemon/server.js'
import {
  daemonErrorFromResponse,
  type ApprovalRecordWire,
  type FetchLike,
} from '../mcp/approvals.js'
import { CliError } from './errors.js'

/**
 * The **owner's** client for the local approval daemon.
 *
 * Deliberately a different object from `HttpApprovalClient` in `src/mcp/`, even
 * though both speak to the same daemon. The MCP client's `ApprovalClient`
 * interface omits `resolve` on purpose (R7 parity: no agent-facing tool may
 * approve anything), and widening it so the CLI could share it would put the
 * one capability the two-tier model exists to withhold back within an agent's
 * reach. Two clients, two capability sets, one wire format.
 *
 * The daemon is auto-started through the same `O_EXCL`-locked
 * {@link ensureDaemonRunning} the MCP server uses, so a CLI `approve` and an
 * agent tool call racing each other still converge on exactly one daemon.
 */

/** Filter for {@link OwnerDaemonClient.list}. */
export interface ListApprovalsOptions {
  status?: ApprovalStatus | 'all'
  limit?: number
  sessionKey?: string
}

/** The daemon's list response. */
export interface ApprovalListWire {
  requests: ApprovalRecordWire[]
  count: number
}

/** Owner decision posted to `/v1/requests/:id/resolve`. */
export interface ResolveApprovalInput {
  decision: 'approve' | 'deny'
  /** Required when approving: the owner's EIP-712 signature over the terms. */
  ownerSignature?: string | null
  ownerAddress?: string | null
  note?: string | null
  /** The terms actually signed, when they differ from what was asked. */
  approvedRequest?: Record<string, unknown> | null
}

/** What the CLI needs from the queue. A superset of the agent's view. */
export interface OwnerApprovalClient {
  list(options?: ListApprovalsOptions): Promise<ApprovalListWire>
  get(id: string): Promise<ApprovalRecordWire>
  resolve(id: string, input: ResolveApprovalInput): Promise<ApprovalRecordWire>
}

export interface OwnerDaemonClientOptions {
  daemon?: EnsureDaemonOptions
  /** Override the connection entirely; skips auto-start. Used by tests. */
  connect?: () => Promise<DaemonConnection>
  fetch?: FetchLike
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Map a daemon failure onto the CLI taxonomy.
 *
 * The `ALREADY_RESOLVED` branch is the one that matters for the owner's review
 * list: between listing pending requests and picking one, an agent may have
 * timed out, the TTL may have passed, or the dashboard may have approved it. The
 * user gets told which of those happened, not "500".
 */
export function toCliDaemonError(error: unknown): CliError {
  if (error instanceof CliError) return error
  if (error instanceof DaemonError) {
    switch (error.code) {
      case 'APPROVAL_REQUEST_ALREADY_RESOLVED':
        return new CliError('ALREADY_RESOLVED', error.message, {
          hint: 'Run `giwacard approve` again to see the current queue.',
          cause: error,
        })
      case 'APPROVAL_REQUEST_EXPIRED':
        return new CliError(
          'ALREADY_RESOLVED',
          `${error.message} Expiry is terminal — the agent has to file a new request.`,
          {
            hint: 'Nothing was signed. Ask the agent to request the card again.',
            cause: error,
          },
        )
      case 'APPROVAL_REQUEST_NOT_FOUND':
        return new CliError('NOT_FOUND', error.message, {
          hint: 'Run `giwacard approve` to list the requests that do exist.',
          cause: error,
        })
      case 'APPROVAL_REQUEST_INVALID':
        return new CliError('INVALID_ARGUMENT', error.message, { cause: error })
      default:
        return new CliError(
          'DAEMON_UNAVAILABLE',
          'The local giwacard approval daemon is not answering.',
          {
            hint: 'Start it in another terminal with `giwacard daemon` and watch for errors.',
            retryable: true,
            cause: error,
          },
        )
    }
  }
  return new CliError(
    'DAEMON_UNAVAILABLE',
    'Could not reach the local giwacard approval daemon.',
    {
      hint: 'Start it in another terminal with `giwacard daemon` and watch for errors.',
      retryable: true,
      cause: error,
    },
  )
}

/** {@link OwnerApprovalClient} over the daemon's loopback HTTP API. */
export class OwnerDaemonClient implements OwnerApprovalClient {
  readonly #options: OwnerDaemonClientOptions
  readonly #fetch: FetchLike
  #connection: Promise<DaemonConnection> | null = null

  constructor(options: OwnerDaemonClientOptions = {}) {
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
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      })
    } catch (cause) {
      this.reset()
      throw toCliDaemonError(cause)
    } finally {
      clearTimeout(timer)
    }

    // A restarted daemon has rotated its CSRF token. Re-resolve once; a second
    // 403 is a genuine authorisation failure, not a stale handle.
    if (response.status === 403 && retryOnAuthFailure) {
      this.reset()
      return this.#request<T>(path, init, false)
    }

    if (!response.ok) throw toCliDaemonError(await daemonErrorFromResponse(response))

    return (await response.json()) as T
  }

  /** @inheritdoc */
  async list(options: ListApprovalsOptions = {}): Promise<ApprovalListWire> {
    const query = new URLSearchParams()
    query.set('status', options.status ?? 'pending')
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    if (options.sessionKey !== undefined) {
      query.set('sessionKey', options.sessionKey)
    }
    return this.#request<ApprovalListWire>(`/v1/requests?${query.toString()}`, {
      method: 'GET',
    })
  }

  /** @inheritdoc */
  async get(id: string): Promise<ApprovalRecordWire> {
    return this.#request<ApprovalRecordWire>(
      `/v1/requests/${encodeURIComponent(id)}`,
      { method: 'GET' },
    )
  }

  /** @inheritdoc */
  async resolve(
    id: string,
    input: ResolveApprovalInput,
  ): Promise<ApprovalRecordWire> {
    return this.#request<ApprovalRecordWire>(
      `/v1/requests/${encodeURIComponent(id)}/resolve`,
      {
        method: 'POST',
        body: {
          decision: input.decision,
          ownerSignature: input.ownerSignature ?? null,
          ownerAddress: input.ownerAddress ?? null,
          note: input.note ?? null,
          approvedRequest: input.approvedRequest ?? null,
        },
      },
    )
  }
}

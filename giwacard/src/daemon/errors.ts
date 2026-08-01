/**
 * Typed errors for the approval daemon.
 *
 * Every error carries a stable machine-readable {@link DaemonErrorCode} and the
 * HTTP status the server should answer with, so `src/daemon/server.ts` can map
 * a thrown domain error onto a response without a pile of `instanceof` checks.
 */

export type DaemonErrorCode =
  /* storage */
  | 'DAEMON_SQLITE_UNAVAILABLE'
  | 'DAEMON_DB_UNSUPPORTED_VERSION'
  /* queue */
  | 'APPROVAL_REQUEST_NOT_FOUND'
  | 'APPROVAL_REQUEST_EXPIRED'
  | 'APPROVAL_REQUEST_ALREADY_RESOLVED'
  | 'APPROVAL_REQUEST_NOT_APPROVED'
  | 'APPROVAL_REQUEST_INVALID'
  | 'APPROVAL_RATE_LIMITED'
  /* transport / hardening */
  | 'DAEMON_ORIGIN_NOT_ALLOWED'
  | 'DAEMON_CSRF_TOKEN_INVALID'
  | 'DAEMON_UNSUPPORTED_MEDIA_TYPE'
  | 'DAEMON_INVALID_JSON'
  | 'DAEMON_NOT_FOUND'
  | 'DAEMON_INTERNAL_ERROR'
  /* lifecycle */
  | 'DAEMON_BIND_REFUSED'
  | 'DAEMON_START_FAILED'
  | 'DAEMON_START_TIMEOUT'

/** Base class for everything this module throws. */
export class DaemonError extends Error {
  override readonly name: string = 'DaemonError'
  readonly code: DaemonErrorCode
  /** Status the HTTP layer should answer with. */
  readonly httpStatus: number
  /** Extra fields merged into the JSON error body. Never secret. */
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: DaemonErrorCode,
    message: string,
    options?: {
      httpStatus?: number
      details?: Record<string, unknown>
      cause?: unknown
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : {})
    this.code = code
    this.httpStatus = options?.httpStatus ?? 500
    this.details = Object.freeze({ ...(options?.details ?? {}) })
  }
}

/* -------------------------------------------------------------------------- */
/* Storage                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The minimum Node that ships `node:sqlite`. Mirrors `engines.node`.
 *
 * Stated as a constant because two things must agree: the version `package.json`
 * refuses to install below, and the version this error tells a user to upgrade
 * to. They drifted once — `engines` said `>=20`, which installs cleanly and then
 * fails at the first over-policy request — so the number lives in one place.
 */
export const MINIMUM_NODE_VERSION = '22.5.0' as const

/**
 * Neither `bun:sqlite` nor `node:sqlite` could be loaded.
 *
 * KTD-10 pins the daemon to SQLite. Bun ships `bun:sqlite`; Node only gained a
 * built-in driver in {@link MINIMUM_NODE_VERSION}. On an older Node there is no
 * embedded database to fall back to, and installing one would break "no extra
 * install".
 *
 * The message names the required version *and* the one actually running: this
 * error is reachable long after install, from an MCP server the user never
 * launched by hand, and "upgrade Node" is unactionable without both numbers.
 */
export class SqliteUnavailableError extends DaemonError {
  override readonly name = 'SqliteUnavailableError'
  constructor(cause?: unknown) {
    const running =
      typeof process !== 'undefined' && typeof process.version === 'string'
        ? process.version
        : 'unknown'
    super(
      'DAEMON_SQLITE_UNAVAILABLE',
      'The giwacard daemon needs an embedded SQLite driver and found none. ' +
        `It requires Node >= ${MINIMUM_NODE_VERSION} (for \`node:sqlite\`) or ` +
        `Bun (for \`bun:sqlite\`); this process is Node ${running}. Upgrade ` +
        'Node, or run giwacard under Bun. Only the over-policy approval flow ' +
        'needs the daemon — in-policy card minting works without it.',
      {
        httpStatus: 503,
        details: { required: MINIMUM_NODE_VERSION, running },
        cause,
      },
    )
  }
}

/** The on-disk schema was written by a newer build than this one. */
export class DaemonSchemaVersionError extends DaemonError {
  override readonly name = 'DaemonSchemaVersionError'
  constructor(found: number, supported: number, path: string) {
    super(
      'DAEMON_DB_UNSUPPORTED_VERSION',
      `The giwacard daemon database at ${path} is at schema version ${found}, ` +
        `but this build only understands version ${supported}. Upgrade giwacard.`,
      { httpStatus: 500, details: { found, supported, path } },
    )
  }
}

/* -------------------------------------------------------------------------- */
/* Queue                                                                      */
/* -------------------------------------------------------------------------- */

export class ApprovalRequestNotFoundError extends DaemonError {
  override readonly name = 'ApprovalRequestNotFoundError'
  constructor(id: string) {
    super('APPROVAL_REQUEST_NOT_FOUND', `No approval request with id ${id}.`, {
      httpStatus: 404,
      details: { id },
    })
  }
}

/**
 * The request's TTL elapsed before anyone resolved it.
 *
 * `expired` is terminal: an expired request can never be approved, even if the
 * owner gets to it a second later. Re-asking is cheap (no gas); silently
 * approving something the agent asked for yesterday is not.
 */
export class ApprovalRequestExpiredError extends DaemonError {
  override readonly name = 'ApprovalRequestExpiredError'
  constructor(id: string, expiresAt: number) {
    super(
      'APPROVAL_REQUEST_EXPIRED',
      `Approval request ${id} expired at ${new Date(expiresAt).toISOString()} ` +
        'and can no longer be resolved. Ask the agent to submit a new one.',
      { httpStatus: 409, details: { id, expiresAt } },
    )
  }
}

/** Approve/deny is one-shot: `approved` and `denied` are both terminal. */
export class ApprovalRequestAlreadyResolvedError extends DaemonError {
  override readonly name = 'ApprovalRequestAlreadyResolvedError'
  constructor(id: string, status: string) {
    super(
      'APPROVAL_REQUEST_ALREADY_RESOLVED',
      `Approval request ${id} is already ${status} and cannot be resolved again.`,
      { httpStatus: 409, details: { id, status } },
    )
  }
}

/** Only an approved request has a signature to consume. */
export class ApprovalRequestNotApprovedError extends DaemonError {
  override readonly name = 'ApprovalRequestNotApprovedError'
  constructor(id: string, status: string) {
    super(
      'APPROVAL_REQUEST_NOT_APPROVED',
      `Approval request ${id} is ${status}, not approved; there is no owner ` +
        'signature to consume.',
      { httpStatus: 409, details: { id, status } },
    )
  }
}

/** Malformed input to `create` or `resolve`. */
export class InvalidApprovalRequestError extends DaemonError {
  override readonly name = 'InvalidApprovalRequestError'
  readonly field: string

  constructor(field: string, detail: string) {
    super('APPROVAL_REQUEST_INVALID', `Invalid ${field}: ${detail}`, {
      httpStatus: 400,
      details: { field },
    })
    this.field = field
  }
}

/**
 * Too many over-policy requests from one session key inside the window.
 *
 * Queueing is free (KTD-10), which is exactly why it needs a limit: an agent in
 * a retry loop would otherwise bury the owner's review list.
 */
export class RateLimitExceededError extends DaemonError {
  override readonly name = 'RateLimitExceededError'
  readonly retryAfterMs: number

  constructor(sessionKey: string, limit: number, windowMs: number, retryAfterMs: number) {
    super(
      'APPROVAL_RATE_LIMITED',
      `Session key ${sessionKey} has already queued ${limit} over-policy ` +
        `request(s) in the last ${Math.round(windowMs / 1000)}s. ` +
        `Retry in ${Math.ceil(retryAfterMs / 1000)}s.`,
      {
        httpStatus: 429,
        details: { sessionKey, limit, windowMs, retryAfterMs },
      },
    )
    this.retryAfterMs = retryAfterMs
  }
}

/* -------------------------------------------------------------------------- */
/* Local-service hardening (KTD-16)                                           */
/* -------------------------------------------------------------------------- */

/**
 * The `Origin` header was present and not on the allowlist.
 *
 * This is the defence against any page the owner happens to have open calling
 * `fetch('http://127.0.0.1:.../v1/requests/<id>/resolve')`.
 */
export class OriginNotAllowedError extends DaemonError {
  override readonly name = 'OriginNotAllowedError'
  constructor(origin: string) {
    super(
      'DAEMON_ORIGIN_NOT_ALLOWED',
      `Origin ${origin} is not allowed to talk to the giwacard daemon.`,
      { httpStatus: 403, details: { origin } },
    )
  }
}

/** The per-session CSRF token was missing or wrong. */
export class CsrfTokenError extends DaemonError {
  override readonly name = 'CsrfTokenError'
  constructor(reason: 'missing' | 'invalid') {
    super(
      'DAEMON_CSRF_TOKEN_INVALID',
      reason === 'missing'
        ? 'Missing daemon token. Send the contents of ~/.giwacard/daemon-token ' +
            'in the X-Giwacard-Token header.'
        : 'Invalid daemon token.',
      { httpStatus: 403, details: { reason } },
    )
  }
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

/** Refused to bind, either because the address is not loopback or it is taken. */
export class DaemonBindError extends DaemonError {
  override readonly name = 'DaemonBindError'
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super('DAEMON_BIND_REFUSED', message, {
      httpStatus: 500,
      ...(details ? { details } : {}),
      cause,
    })
  }
}

/** Auto-start spawned (or was told to spawn) a daemon that never came up. */
export class DaemonStartTimeoutError extends DaemonError {
  override readonly name = 'DaemonStartTimeoutError'
  constructor(timeoutMs: number, cause?: unknown) {
    super(
      'DAEMON_START_TIMEOUT',
      `The giwacard daemon did not become reachable within ${timeoutMs}ms. ` +
        'Start it manually with `giwacard daemon` to see why.',
      { httpStatus: 503, details: { timeoutMs }, cause },
    )
  }
}

/** Auto-start could not even launch a daemon process. */
export class DaemonStartError extends DaemonError {
  override readonly name = 'DaemonStartError'
  constructor(message: string, cause?: unknown) {
    super('DAEMON_START_FAILED', message, { httpStatus: 503, cause })
  }
}

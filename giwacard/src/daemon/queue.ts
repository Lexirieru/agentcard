import { randomUUID } from 'node:crypto'

import type { Hex } from '../chain/keystore.js'
import type { SqlDatabase, SqlStatement } from './db.js'
import {
  ApprovalRequestAlreadyResolvedError,
  ApprovalRequestExpiredError,
  ApprovalRequestNotApprovedError,
  ApprovalRequestNotFoundError,
  InvalidApprovalRequestError,
  RateLimitExceededError,
} from './errors.js'

/**
 * The over-policy approval queue (KTD-10).
 *
 * An agent that wants a card exceeding its session key's onchain policy cannot
 * mint it. Instead the request lands here, the human owner reviews it, and
 * approving produces an owner EIP-712 signature which is stored until the mint
 * consumes it. The daemon holds no key of any kind: the signature is produced by
 * the owner's client and POSTed in.
 *
 * Two invariants shape the whole design:
 *
 * 1. **Expiry is computed, never scheduled.** A background timer would not be
 *    running while the daemon is down, so a request could come back from a
 *    restart still looking `pending` hours after its TTL. Every read derives the
 *    terminal `expired` state from `expires_at` and the current clock; the row
 *    update that follows is a cache, not the source of truth.
 * 2. **Resolution is one-shot.** `approved`, `denied` and `expired` are all
 *    terminal. A denied request can never later be approved.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** Lifecycle of an over-policy request. Only `pending` is non-terminal. */
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired'

/**
 * The card the agent asked for, verbatim.
 *
 * Deliberately schemaless: the exact policy fields (cap, token, merchant
 * allowlist, expiry) belong to the card contracts, and the daemon must keep
 * working when they change. It is stored as JSON and handed back untouched, so
 * whatever the owner signs is exactly what the agent asked for.
 */
export type OverPolicyCardRequest = Readonly<Record<string, unknown>>

/** A queue row, with `status` already adjusted for expiry. */
export interface ApprovalRequestRecord {
  id: string
  /** Address of the session key that asked. Rate-limit and idempotency bucket. */
  sessionKey: Hex
  /** Free-text agent label, for the owner's benefit. */
  agent: string | null
  status: ApprovalStatus
  /** Why the request is over policy, as reported by the requester. */
  reason: string | null
  request: OverPolicyCardRequest
  idempotencyKey: string | null
  /** Epoch ms. */
  createdAt: number
  /** Epoch ms. After this the request reads as `expired`. */
  expiresAt: number
  /** Epoch ms. For `expired` this is `expiresAt`, so it stays deterministic. */
  resolvedAt: number | null
  /** Owner address that resolved it, when the client supplied one. */
  resolvedBy: Hex | null
  decisionNote: string | null
  /** Owner EIP-712 signature. `null` before approval and after consumption. */
  ownerSignature: Hex | null
  /** Epoch ms at which the signature was consumed onchain and deleted. */
  signatureConsumedAt: number | null
  /** Set by the consumer so the agent can find its card statelessly. */
  cardId: string | null
  mintTxHash: Hex | null
}

export interface CreateApprovalRequestInput {
  /** Address of the requesting session key. */
  sessionKey: string
  request: Record<string, unknown>
  reason?: string | null
  agent?: string | null
  /** Retry-safe key. A repeat create returns the original request unchanged. */
  idempotencyKey?: string | null
  /** Override the queue TTL, clamped to [{@link MIN_TTL_MS}, {@link MAX_TTL_MS}]. */
  ttlMs?: number
}

export interface ResolveApprovalRequestInput {
  decision: 'approve' | 'deny'
  /** Required for `approve`. The owner's EIP-712 signature over the request. */
  ownerSignature?: string | null
  /** Owner address that produced the signature, if the client knows it. */
  ownerAddress?: string | null
  note?: string | null
  /**
   * Terms the owner actually signed, when they differ from what was asked.
   *
   * The signature commits to specific parameters; storing the original request
   * next to a signature over amended ones would hand the agent a signature that
   * does not match the record it is reading.
   */
  approvedRequest?: Record<string, unknown> | null
}

/** Outcome of {@link ApprovalQueue.create}. */
export interface ApprovalCreateResult {
  record: ApprovalRequestRecord
  /**
   * `false` when an `idempotencyKey` matched an existing request and nothing was
   * queued. The HTTP layer turns this into 200-vs-201 so a retrying client can
   * tell the difference.
   */
  created: boolean
}

export interface MarkConsumedInput {
  /** Card identifier the mint produced, so the agent can find its card. */
  cardId?: string | null
  mintTxHash?: string | null
}

export interface ListApprovalRequestsOptions {
  /** Defaults to `pending` — what the owner's review list wants. */
  status?: ApprovalStatus | 'all'
  sessionKey?: string
  /** Defaults to 100, capped at {@link MAX_LIST_LIMIT}. */
  limit?: number
}

/** Per-session-key rate limit for free (gasless) over-policy requests. */
export interface ApprovalRateLimit {
  /** Requests allowed per window. */
  max: number
  windowMs: number
}

export interface ApprovalQueueOptions {
  /** Default TTL for new requests. KTD-10 default: 24h. */
  ttlMs?: number
  rateLimit?: ApprovalRateLimit
  /** Injected clock, in epoch ms. Tests use this to travel past a TTL. */
  now?: () => number
}

/* -------------------------------------------------------------------------- */
/* Defaults + validation                                                      */
/* -------------------------------------------------------------------------- */

/** KTD-10: an unresolved request expires after 24h. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
/** Shortest TTL a caller may ask for: one minute. */
export const MIN_TTL_MS = 60 * 1000
/** Longest TTL a caller may ask for: seven days. */
export const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** KTD-10: queueing is free, so it is capped per session key. */
export const DEFAULT_RATE_LIMIT: ApprovalRateLimit = {
  max: 20,
  windowMs: 60 * 60 * 1000,
}

/** Upper bound on `list(limit)`, so one call cannot page in the whole table. */
export const MAX_LIST_LIMIT = 500

/** Serialized `request` payloads above this are rejected rather than stored. */
export const MAX_REQUEST_JSON_BYTES = 16 * 1024

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const SIGNATURE_RE = /^0x(?:[0-9a-fA-F]{2})+$/
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/
const MAX_TEXT_LENGTH = 2000

function normalizeAddress(value: unknown, field: string): Hex {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value)) {
    throw new InvalidApprovalRequestError(
      field,
      'expected a 0x-prefixed 20-byte address',
    )
  }
  return value.toLowerCase() as Hex
}

function optionalText(
  value: unknown,
  field: string,
  maxLength = MAX_TEXT_LENGTH,
): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new InvalidApprovalRequestError(field, 'expected a string')
  }
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > maxLength) {
    throw new InvalidApprovalRequestError(
      field,
      `must be at most ${maxLength} characters`,
    )
  }
  return trimmed
}

function serializeRequest(value: unknown, field: string): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new InvalidApprovalRequestError(field, 'expected a JSON object')
  }
  let json: string
  try {
    json = JSON.stringify(value)
  } catch {
    throw new InvalidApprovalRequestError(field, 'is not JSON-serializable')
  }
  if (json === undefined) {
    throw new InvalidApprovalRequestError(field, 'is not JSON-serializable')
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_REQUEST_JSON_BYTES) {
    throw new InvalidApprovalRequestError(
      field,
      `must serialize to at most ${MAX_REQUEST_JSON_BYTES} bytes`,
    )
  }
  return json
}

function clampTtl(ttlMs: unknown, fallback: number): number {
  if (ttlMs === undefined || ttlMs === null) return fallback
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) {
    throw new InvalidApprovalRequestError('ttlMs', 'expected a finite number')
  }
  return Math.min(Math.max(Math.floor(ttlMs), MIN_TTL_MS), MAX_TTL_MS)
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return null
}

/* -------------------------------------------------------------------------- */
/* Row mapping                                                                */
/* -------------------------------------------------------------------------- */

interface ApprovalRow {
  id: string
  session_key: string
  agent: string | null
  status: string
  reason: string | null
  request_json: string
  idempotency_key: string | null
  created_at: number | bigint
  expires_at: number | bigint
  resolved_at: number | bigint | null
  resolved_by: string | null
  decision_note: string | null
  owner_signature: string | null
  signature_consumed_at: number | bigint | null
  card_id: string | null
  mint_tx_hash: string | null
}

/**
 * Terminal status of a row as of `now`.
 *
 * This is the single place expiry is decided. It is a pure function of the row
 * and the clock, so two readers at the same instant always agree — whether or
 * not the lazy `UPDATE` in {@link ApprovalQueue} has run yet.
 */
export function effectiveStatus(
  row: { status: string; expiresAt: number },
  now: number,
): ApprovalStatus {
  if (row.status === 'pending' && now >= row.expiresAt) return 'expired'
  return row.status as ApprovalStatus
}

function rowToRecord(row: ApprovalRow, now: number): ApprovalRequestRecord {
  const createdAt = toNumber(row.created_at) ?? 0
  const expiresAt = toNumber(row.expires_at) ?? 0
  const status = effectiveStatus({ status: row.status, expiresAt }, now)

  let request: OverPolicyCardRequest
  try {
    request = JSON.parse(row.request_json) as OverPolicyCardRequest
  } catch {
    request = {}
  }

  return {
    id: row.id,
    sessionKey: row.session_key as Hex,
    agent: row.agent,
    status,
    reason: row.reason,
    request,
    idempotencyKey: row.idempotency_key,
    createdAt,
    expiresAt,
    // An expired request's `resolvedAt` is its own deadline, not the moment
    // someone happened to read it — otherwise the record would change every
    // time it is fetched.
    resolvedAt:
      status === 'expired' ? expiresAt : toNumber(row.resolved_at),
    resolvedBy: row.resolved_by as Hex | null,
    decisionNote: row.decision_note,
    ownerSignature: row.owner_signature as Hex | null,
    signatureConsumedAt: toNumber(row.signature_consumed_at),
    cardId: row.card_id,
    mintTxHash: row.mint_tx_hash as Hex | null,
  }
}

/* -------------------------------------------------------------------------- */
/* Queue                                                                      */
/* -------------------------------------------------------------------------- */

const SELECT_COLUMNS = `
  id, session_key, agent, status, reason, request_json, idempotency_key,
  created_at, expires_at, resolved_at, resolved_by, decision_note,
  owner_signature, signature_consumed_at, card_id, mint_tx_hash
`

/** The approval queue, backed by the SQLite database from `./db.ts`. */
export class ApprovalQueue {
  readonly #db: SqlDatabase
  readonly #now: () => number
  readonly #ttlMs: number
  readonly #rateLimit: ApprovalRateLimit

  readonly #insert: SqlStatement
  readonly #selectById: SqlStatement
  readonly #selectByIdempotency: SqlStatement
  readonly #expireDue: SqlStatement
  readonly #countInWindow: SqlStatement
  readonly #oldestInWindow: SqlStatement
  readonly #resolve: SqlStatement
  readonly #consume: SqlStatement

  constructor(db: SqlDatabase, options: ApprovalQueueOptions = {}) {
    this.#db = db
    this.#now = options.now ?? (() => Date.now())
    this.#ttlMs = clampTtl(options.ttlMs, DEFAULT_TTL_MS)
    this.#rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT

    this.#insert = db.prepare(
      `INSERT INTO approval_requests (
         id, session_key, agent, status, reason, request_json, idempotency_key,
         created_at, expires_at
       ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    )
    this.#selectById = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM approval_requests WHERE id = ?`,
    )
    this.#selectByIdempotency = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM approval_requests
       WHERE session_key = ? AND idempotency_key = ?`,
    )
    this.#expireDue = db.prepare(
      `UPDATE approval_requests
          SET status = 'expired', resolved_at = expires_at
        WHERE status = 'pending' AND expires_at <= ?`,
    )
    this.#countInWindow = db.prepare(
      `SELECT COUNT(*) AS n FROM approval_requests
        WHERE session_key = ? AND created_at > ?`,
    )
    this.#oldestInWindow = db.prepare(
      `SELECT MIN(created_at) AS oldest FROM approval_requests
        WHERE session_key = ? AND created_at > ?`,
    )
    this.#resolve = db.prepare(
      `UPDATE approval_requests
          SET status = ?, resolved_at = ?, resolved_by = ?, decision_note = ?,
              owner_signature = ?, request_json = ?
        WHERE id = ? AND status = 'pending'`,
    )
    this.#consume = db.prepare(
      `UPDATE approval_requests
          SET owner_signature = NULL,
              signature_consumed_at = COALESCE(signature_consumed_at, ?),
              card_id = COALESCE(?, card_id),
              mint_tx_hash = COALESCE(?, mint_tx_hash)
        WHERE id = ?`,
    )
  }

  /** Default TTL applied to new requests, in ms. */
  get ttlMs(): number {
    return this.#ttlMs
  }

  /** Active per-session-key rate limit. */
  get rateLimit(): ApprovalRateLimit {
    return this.#rateLimit
  }

  /**
   * Fold every due `pending` row into `expired`.
   *
   * Called at the top of every operation. This is a materialization of what
   * {@link effectiveStatus} already says, so skipping it (e.g. on a read-only
   * database) changes nothing a caller can observe.
   */
  #sweep(now: number): void {
    this.#expireDue.run(now)
  }

  #assertRateLimit(sessionKey: Hex, now: number): void {
    const { max, windowMs } = this.#rateLimit
    if (max <= 0) {
      throw new RateLimitExceededError(sessionKey, max, windowMs, windowMs)
    }
    const windowStart = now - windowMs
    const row = this.#countInWindow.get(sessionKey, windowStart) as
      | { n?: unknown }
      | undefined
      | null
    const count = toNumber(row?.n) ?? 0
    if (count < max) return

    const oldestRow = this.#oldestInWindow.get(sessionKey, windowStart) as
      | { oldest?: unknown }
      | undefined
      | null
    const oldest = toNumber(oldestRow?.oldest)
    const retryAfterMs =
      oldest === null ? windowMs : Math.max(1, oldest + windowMs - now)
    throw new RateLimitExceededError(sessionKey, max, windowMs, retryAfterMs)
  }

  #findByIdempotency(
    sessionKey: Hex,
    idempotencyKey: string,
    now: number,
  ): ApprovalRequestRecord | null {
    const row = this.#selectByIdempotency.get(sessionKey, idempotencyKey) as
      | ApprovalRow
      | undefined
      | null
    return row ? rowToRecord(row, now) : null
  }

  /**
   * Queue an over-policy request.
   *
   * Free of charge (no transaction is sent), hence the per-session-key rate
   * limit. Passing an `idempotencyKey` makes a retried create return the
   * original request instead of queueing a second one — and a replay does not
   * consume rate-limit budget, since it is not a new request.
   */
  create(input: CreateApprovalRequestInput): ApprovalCreateResult {
    const now = this.#now()
    this.#sweep(now)

    const sessionKey = normalizeAddress(input.sessionKey, 'sessionKey')
    const idempotencyKey = optionalText(
      input.idempotencyKey,
      'idempotencyKey',
      200,
    )

    if (idempotencyKey !== null) {
      const existing = this.#findByIdempotency(sessionKey, idempotencyKey, now)
      if (existing) return { record: existing, created: false }
    }

    const requestJson = serializeRequest(input.request, 'request')
    const reason = optionalText(input.reason, 'reason')
    const agent = optionalText(input.agent, 'agent', 200)
    const ttlMs = clampTtl(input.ttlMs, this.#ttlMs)

    this.#assertRateLimit(sessionKey, now)

    const id = randomUUID()
    try {
      this.#insert.run(
        id,
        sessionKey,
        agent,
        reason,
        requestJson,
        idempotencyKey,
        now,
        now + ttlMs,
      )
    } catch (error) {
      // Another process won the same idempotency key between our lookup and our
      // insert. The unique index is the real arbiter; fall back to its winner.
      if (idempotencyKey !== null && isUniqueConstraintError(error)) {
        const existing = this.#findByIdempotency(sessionKey, idempotencyKey, now)
        if (existing) return { record: existing, created: false }
      }
      throw error
    }

    return { record: this.get(id), created: true }
  }

  /** Fetch one request. Throws when it does not exist. */
  get(id: string): ApprovalRequestRecord {
    const record = this.tryGet(id)
    if (!record) throw new ApprovalRequestNotFoundError(id)
    return record
  }

  /** Fetch one request, or `null`. Expiry is applied before returning. */
  tryGet(id: string): ApprovalRequestRecord | null {
    if (typeof id !== 'string' || id === '') return null
    const now = this.#now()
    this.#sweep(now)
    const row = this.#selectById.get(id) as ApprovalRow | undefined | null
    return row ? rowToRecord(row, now) : null
  }

  /** List requests, newest first. Defaults to the owner's pending review list. */
  list(options: ListApprovalRequestsOptions = {}): ApprovalRequestRecord[] {
    const now = this.#now()
    this.#sweep(now)

    const status = options.status ?? 'pending'
    const limit = Math.min(
      Math.max(Math.floor(options.limit ?? 100), 1),
      MAX_LIST_LIMIT,
    )

    const where: string[] = []
    const params: (string | number)[] = []
    if (status !== 'all') {
      where.push('status = ?')
      params.push(status)
    }
    if (options.sessionKey !== undefined) {
      where.push('session_key = ?')
      params.push(normalizeAddress(options.sessionKey, 'sessionKey'))
    }

    const sql =
      `SELECT ${SELECT_COLUMNS} FROM approval_requests` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ' ORDER BY created_at DESC, id DESC LIMIT ?'
    params.push(limit)

    const rows = this.#db.prepare(sql).all(...params) as ApprovalRow[]
    return rows.map((row) => rowToRecord(row, now))
  }

  /**
   * Approve or deny. One-shot, and only from `pending`.
   *
   * Approving stores the owner's signature verbatim; the daemon cannot verify it
   * (it does not know the card contract's EIP-712 domain and holds no key), so
   * the real check is the onchain one at mint time. What the daemon does
   * guarantee is that the signature it hands back is bound to the request body
   * stored alongside it.
   */
  resolve(
    id: string,
    input: ResolveApprovalRequestInput,
  ): ApprovalRequestRecord {
    const now = this.#now()
    this.#sweep(now)

    const current = this.get(id)
    if (current.status === 'expired') {
      throw new ApprovalRequestExpiredError(id, current.expiresAt)
    }
    if (current.status !== 'pending') {
      throw new ApprovalRequestAlreadyResolvedError(id, current.status)
    }

    if (input.decision !== 'approve' && input.decision !== 'deny') {
      throw new InvalidApprovalRequestError(
        'decision',
        `expected "approve" or "deny", got ${JSON.stringify(input.decision)}`,
      )
    }

    const note = optionalText(input.note, 'note')
    const ownerAddress =
      input.ownerAddress === undefined || input.ownerAddress === null
        ? null
        : normalizeAddress(input.ownerAddress, 'ownerAddress')

    let signature: string | null = null
    let requestJson = JSON.stringify(current.request)

    if (input.decision === 'approve') {
      const raw = input.ownerSignature
      if (typeof raw !== 'string' || raw.trim() === '') {
        throw new InvalidApprovalRequestError(
          'ownerSignature',
          'approving requires the owner signature that will authorise the mint',
        )
      }
      const trimmed = raw.trim()
      if (!SIGNATURE_RE.test(trimmed) || trimmed.length < 66) {
        throw new InvalidApprovalRequestError(
          'ownerSignature',
          'expected 0x-prefixed hex of at least 32 bytes',
        )
      }
      signature = trimmed.toLowerCase()

      if (
        input.approvedRequest !== undefined &&
        input.approvedRequest !== null
      ) {
        requestJson = serializeRequest(input.approvedRequest, 'approvedRequest')
      }
    } else if (
      input.ownerSignature !== undefined &&
      input.ownerSignature !== null &&
      String(input.ownerSignature).trim() !== ''
    ) {
      throw new InvalidApprovalRequestError(
        'ownerSignature',
        'a denial must not carry a signature',
      )
    }

    const status: ApprovalStatus =
      input.decision === 'approve' ? 'approved' : 'denied'

    this.#resolve.run(
      status,
      now,
      ownerAddress,
      note,
      signature,
      requestJson,
      id,
    )

    return this.get(id)
  }

  /**
   * Mark the owner signature as spent onchain and delete it (KTD-16).
   *
   * Idempotent: calling it again only fills in `cardId`/`mintTxHash` if they are
   * still unset, so a consumer that crashes after minting can safely retry.
   */
  markConsumed(id: string, input: MarkConsumedInput = {}): ApprovalRequestRecord {
    const now = this.#now()
    this.#sweep(now)

    const current = this.get(id)
    if (current.status !== 'approved') {
      throw new ApprovalRequestNotApprovedError(id, current.status)
    }

    const cardId = optionalText(input.cardId, 'cardId', 200)
    let mintTxHash: string | null = null
    if (input.mintTxHash !== undefined && input.mintTxHash !== null) {
      const trimmed = String(input.mintTxHash).trim()
      if (trimmed !== '') {
        if (!TX_HASH_RE.test(trimmed)) {
          throw new InvalidApprovalRequestError(
            'mintTxHash',
            'expected a 0x-prefixed 32-byte transaction hash',
          )
        }
        mintTxHash = trimmed.toLowerCase()
      }
    }

    this.#consume.run(now, cardId, mintTxHash, id)
    return this.get(id)
  }

  /** Counts per status, with expiry already applied. */
  stats(): Record<ApprovalStatus, number> {
    const now = this.#now()
    this.#sweep(now)
    const rows = this.#db
      .prepare('SELECT status, COUNT(*) AS n FROM approval_requests GROUP BY status')
      .all() as { status: string; n: number | bigint }[]

    const counts: Record<ApprovalStatus, number> = {
      pending: 0,
      approved: 0,
      denied: 0,
      expired: 0,
    }
    for (const row of rows) {
      if (
        row.status === 'pending' ||
        row.status === 'approved' ||
        row.status === 'denied' ||
        row.status === 'expired'
      ) {
        counts[row.status] = toNumber(row.n) ?? 0
      }
    }
    return counts
  }

  /** Close the underlying database. */
  close(): void {
    this.#db.close()
  }
}

/** Whether a driver error is SQLite's UNIQUE constraint violation. */
function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; message?: unknown }
  if (typeof candidate.code === 'string' && candidate.code.includes('SQLITE_CONSTRAINT')) {
    return true
  }
  return (
    typeof candidate.message === 'string' &&
    /unique constraint/i.test(candidate.message)
  )
}

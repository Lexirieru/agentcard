import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDaemonDatabase, type SqlDatabase } from './db.js'
import {
  ApprovalRequestAlreadyResolvedError,
  ApprovalRequestExpiredError,
  ApprovalRequestNotApprovedError,
  ApprovalRequestNotFoundError,
  InvalidApprovalRequestError,
  RateLimitExceededError,
} from './errors.js'
import {
  ApprovalQueue,
  DEFAULT_TTL_MS,
  MAX_REQUEST_JSON_BYTES,
  MAX_TTL_MS,
  MIN_TTL_MS,
  effectiveStatus,
  type ApprovalQueueOptions,
} from './queue.js'

const SESSION_A = '0x1111111111111111111111111111111111111111'
const SESSION_B = '0x2222222222222222222222222222222222222222'
const OWNER = '0x3333333333333333333333333333333333333333'
/** 65-byte secp256k1 signature shape. */
const SIGNATURE = `0x${'ab'.repeat(65)}` as `0x${string}`
const TX_HASH = `0x${'11'.repeat(32)}` as `0x${string}`
const OTHER_TX_HASH = `0x${'22'.repeat(32)}` as `0x${string}`

const OVER_POLICY = {
  token: '0x4444444444444444444444444444444444444444',
  cap: '250000000',
  merchant: '0x5555555555555555555555555555555555555555',
  expiresAt: 1893456000,
}

let dir: string
let db: SqlDatabase
let clock: number

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'giwacard-daemon-queue-'))
  db = await openDaemonDatabase({ dir })
  clock = 1_700_000_000_000
})

afterEach(() => {
  try {
    db.close()
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true })
})

function makeQueue(options: ApprovalQueueOptions = {}): ApprovalQueue {
  return new ApprovalQueue(db, { now: () => clock, ...options })
}

function createOne(queue: ApprovalQueue, overrides: Record<string, unknown> = {}) {
  return queue.create({
    sessionKey: SESSION_A,
    request: OVER_POLICY,
    reason: 'cap exceeds session policy',
    agent: 'claude-code',
    ...overrides,
  })
}

/* -------------------------------------------------------------------------- */

describe('create', () => {
  test('queues a pending request with the default 24h TTL', () => {
    const queue = makeQueue()
    const { record, created } = createOne(queue)

    expect(created).toBe(true)
    expect(record.status).toBe('pending')
    expect(record.sessionKey).toBe(SESSION_A)
    expect(record.agent).toBe('claude-code')
    expect(record.reason).toBe('cap exceeds session policy')
    expect(record.createdAt).toBe(clock)
    expect(record.expiresAt).toBe(clock + DEFAULT_TTL_MS)
    expect(record.ownerSignature).toBeNull()
    expect(record.resolvedAt).toBeNull()
  })

  test('stores the card request verbatim', () => {
    const queue = makeQueue()
    const { record } = createOne(queue)
    expect(record.request).toEqual(OVER_POLICY)
  })

  test('normalises the session key to lowercase so buckets cannot be split', () => {
    const queue = makeQueue({ rateLimit: { max: 1, windowMs: 60_000 } })
    createOne(queue, { sessionKey: SESSION_A.toUpperCase().replace('0X', '0x') })
    // Same key in different case must hit the same rate-limit bucket.
    expect(() => createOne(queue, { sessionKey: SESSION_A })).toThrow(
      RateLimitExceededError,
    )
  })

  test('clamps a too-short or too-long TTL rather than rejecting it', () => {
    const queue = makeQueue()
    const short = createOne(queue, { ttlMs: 1, idempotencyKey: 'short' }).record
    const long = createOne(queue, {
      ttlMs: MAX_TTL_MS * 10,
      idempotencyKey: 'long',
    }).record
    expect(short.expiresAt - short.createdAt).toBe(MIN_TTL_MS)
    expect(long.expiresAt - long.createdAt).toBe(MAX_TTL_MS)
  })

  test('rejects a malformed session key', () => {
    const queue = makeQueue()
    expect(() => createOne(queue, { sessionKey: 'not-an-address' })).toThrow(
      InvalidApprovalRequestError,
    )
  })

  test('rejects a non-object request payload', () => {
    const queue = makeQueue()
    expect(() => createOne(queue, { request: ['nope'] })).toThrow(
      InvalidApprovalRequestError,
    )
  })

  test('rejects a request payload that would bloat the database', () => {
    const queue = makeQueue()
    const huge = { memo: 'x'.repeat(MAX_REQUEST_JSON_BYTES + 1) }
    expect(() => createOne(queue, { request: huge })).toThrow(
      InvalidApprovalRequestError,
    )
  })
})

describe('idempotency', () => {
  test('a retried create does not double-queue', () => {
    const queue = makeQueue()
    const first = createOne(queue, { idempotencyKey: 'mint-attempt-1' })
    const second = createOne(queue, { idempotencyKey: 'mint-attempt-1' })

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.record.id).toBe(first.record.id)
    expect(queue.list({ status: 'all' })).toHaveLength(1)
  })

  test('a replay returns the original terms, not the retried ones', () => {
    const queue = makeQueue()
    const first = createOne(queue, { idempotencyKey: 'k' })
    const second = createOne(queue, {
      idempotencyKey: 'k',
      request: { cap: '999999999999' },
    })
    expect(second.record.request).toEqual(OVER_POLICY)
    expect(second.record.id).toBe(first.record.id)
  })

  test('a replay does not consume rate-limit budget', () => {
    const queue = makeQueue({ rateLimit: { max: 2, windowMs: 60_000 } })
    createOne(queue, { idempotencyKey: 'k' })
    createOne(queue, { idempotencyKey: 'k' })
    createOne(queue, { idempotencyKey: 'k' })
    // Only one real request was queued, so one slot is still free.
    expect(() => createOne(queue, { idempotencyKey: 'other' })).not.toThrow()
  })

  test('the key is scoped per session key', () => {
    const queue = makeQueue()
    const a = createOne(queue, { idempotencyKey: 'shared' })
    const b = createOne(queue, {
      sessionKey: SESSION_B,
      idempotencyKey: 'shared',
    })
    expect(b.created).toBe(true)
    expect(b.record.id).not.toBe(a.record.id)
  })

  test('requests without a key are never deduplicated', () => {
    const queue = makeQueue()
    createOne(queue)
    createOne(queue)
    expect(queue.list({ status: 'all' })).toHaveLength(2)
  })
})

describe('rate limiting', () => {
  test('the N+1th request in the window is rejected', () => {
    const queue = makeQueue({ rateLimit: { max: 3, windowMs: 60_000 } })
    for (let i = 0; i < 3; i++) createOne(queue)
    expect(() => createOne(queue)).toThrow(RateLimitExceededError)
  })

  test('the error carries a usable Retry-After hint', () => {
    const queue = makeQueue({ rateLimit: { max: 1, windowMs: 60_000 } })
    createOne(queue)
    clock += 10_000
    try {
      createOne(queue)
      throw new Error('expected a rate-limit rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitExceededError)
      expect((error as RateLimitExceededError).retryAfterMs).toBe(50_000)
      expect((error as RateLimitExceededError).httpStatus).toBe(429)
    }
  })

  test('the window slides: budget frees up once requests age out', () => {
    const queue = makeQueue({ rateLimit: { max: 2, windowMs: 60_000 } })
    createOne(queue)
    createOne(queue)
    expect(() => createOne(queue)).toThrow(RateLimitExceededError)
    clock += 60_001
    expect(() => createOne(queue)).not.toThrow()
  })

  test('is per session key, so one agent cannot starve another', () => {
    const queue = makeQueue({ rateLimit: { max: 1, windowMs: 60_000 } })
    createOne(queue)
    expect(() => createOne(queue, { sessionKey: SESSION_B })).not.toThrow()
  })

  test('counts resolved and expired requests too', () => {
    const queue = makeQueue({ rateLimit: { max: 2, windowMs: 60_000 } })
    const first = createOne(queue).record
    queue.resolve(first.id, { decision: 'deny' })
    createOne(queue)
    // Denying does not hand the budget back — queueing was the costly act.
    expect(() => createOne(queue)).toThrow(RateLimitExceededError)
  })
})

describe('expiry', () => {
  test('an unresolved request past its TTL reads as expired', () => {
    const queue = makeQueue()
    const { record } = createOne(queue, { ttlMs: MIN_TTL_MS })
    expect(queue.get(record.id).status).toBe('pending')

    clock += MIN_TTL_MS
    expect(queue.get(record.id).status).toBe('expired')
  })

  test('is deterministic across daemon restarts (no timer involved)', async () => {
    const queue = makeQueue()
    const { record } = createOne(queue, { ttlMs: MIN_TTL_MS })

    // Simulate the daemon being down across the deadline: close everything, let
    // the clock pass the TTL, then reopen. A background timer would have missed
    // the transition entirely.
    db.close()
    clock += MIN_TTL_MS * 5
    db = await openDaemonDatabase({ dir })

    const reopened = makeQueue()
    expect(reopened.get(record.id).status).toBe('expired')
  })

  test('reports expiry even before the row is rewritten', () => {
    const queue = makeQueue()
    const { record } = createOne(queue, { ttlMs: MIN_TTL_MS })
    clock += MIN_TTL_MS

    // The raw row still says 'pending' until a sweep touches it...
    const raw = db
      .prepare('SELECT status FROM approval_requests WHERE id = ?')
      .get(record.id) as { status: string }
    expect(raw.status).toBe('pending')

    // ...but the derived status never depends on that having happened.
    expect(
      effectiveStatus({ status: raw.status, expiresAt: record.expiresAt }, clock),
    ).toBe('expired')
    expect(queue.get(record.id).status).toBe('expired')
  })

  test('resolvedAt for an expired request is its deadline, not the read time', () => {
    const queue = makeQueue()
    const { record } = createOne(queue, { ttlMs: MIN_TTL_MS })
    clock += MIN_TTL_MS
    const first = queue.get(record.id)
    clock += 10_000_000
    const second = queue.get(record.id)

    expect(first.resolvedAt).toBe(record.expiresAt)
    expect(second.resolvedAt).toBe(record.expiresAt)
  })

  test('an expired request cannot be approved', () => {
    const queue = makeQueue()
    const { record } = createOne(queue, { ttlMs: MIN_TTL_MS })
    clock += MIN_TTL_MS

    expect(() =>
      queue.resolve(record.id, { decision: 'approve', ownerSignature: SIGNATURE }),
    ).toThrow(ApprovalRequestExpiredError)
  })

  test('an expired request cannot be denied either', () => {
    const queue = makeQueue()
    const { record } = createOne(queue, { ttlMs: MIN_TTL_MS })
    clock += MIN_TTL_MS
    expect(() => queue.resolve(record.id, { decision: 'deny' })).toThrow(
      ApprovalRequestExpiredError,
    )
  })

  test('expiry does not touch already-resolved requests', () => {
    const queue = makeQueue()
    const { record } = createOne(queue, { ttlMs: MIN_TTL_MS })
    queue.resolve(record.id, { decision: 'approve', ownerSignature: SIGNATURE })
    clock += MIN_TTL_MS * 100
    expect(queue.get(record.id).status).toBe('approved')
  })

  test('a request exactly at its deadline is expired, not pending', () => {
    const queue = makeQueue()
    const { record } = createOne(queue, { ttlMs: MIN_TTL_MS })
    clock = record.expiresAt
    expect(queue.get(record.id).status).toBe('expired')
  })
})

describe('resolve', () => {
  test('approving stores the owner signature and address', () => {
    const queue = makeQueue()
    const { record } = createOne(queue)
    const resolved = queue.resolve(record.id, {
      decision: 'approve',
      ownerSignature: SIGNATURE,
      ownerAddress: OWNER,
      note: 'one-off, trusted merchant',
    })

    expect(resolved.status).toBe('approved')
    expect(resolved.ownerSignature).toBe(SIGNATURE)
    expect(resolved.resolvedBy).toBe(OWNER)
    expect(resolved.decisionNote).toBe('one-off, trusted merchant')
    expect(resolved.resolvedAt).toBe(clock)
  })

  test('approving without a signature is refused', () => {
    const queue = makeQueue()
    const { record } = createOne(queue)
    expect(() => queue.resolve(record.id, { decision: 'approve' })).toThrow(
      InvalidApprovalRequestError,
    )
    expect(queue.get(record.id).status).toBe('pending')
  })

  test('a malformed signature is refused', () => {
    const queue = makeQueue()
    const { record } = createOne(queue)
    for (const bad of ['0xzz', 'no-prefix', '0xabc', `0x${'ab'.repeat(4)}`]) {
      expect(() =>
        queue.resolve(record.id, { decision: 'approve', ownerSignature: bad }),
      ).toThrow(InvalidApprovalRequestError)
    }
  })

  test('deny is terminal: a denied request cannot later be approved', () => {
    const queue = makeQueue()
    const { record } = createOne(queue)
    const denied = queue.resolve(record.id, {
      decision: 'deny',
      note: 'not this merchant',
    })
    expect(denied.status).toBe('denied')
    expect(denied.ownerSignature).toBeNull()

    expect(() =>
      queue.resolve(record.id, { decision: 'approve', ownerSignature: SIGNATURE }),
    ).toThrow(ApprovalRequestAlreadyResolvedError)
    expect(queue.get(record.id).status).toBe('denied')
    expect(queue.get(record.id).ownerSignature).toBeNull()
  })

  test('approve is terminal too: no second signature can replace the first', () => {
    const queue = makeQueue()
    const { record } = createOne(queue)
    queue.resolve(record.id, { decision: 'approve', ownerSignature: SIGNATURE })
    const other = `0x${'cd'.repeat(65)}` as `0x${string}`
    expect(() =>
      queue.resolve(record.id, { decision: 'approve', ownerSignature: other }),
    ).toThrow(ApprovalRequestAlreadyResolvedError)
    expect(queue.get(record.id).ownerSignature).toBe(SIGNATURE)
  })

  test('a denial carrying a signature is refused outright', () => {
    const queue = makeQueue()
    const { record } = createOne(queue)
    expect(() =>
      queue.resolve(record.id, { decision: 'deny', ownerSignature: SIGNATURE }),
    ).toThrow(InvalidApprovalRequestError)
  })

  test('an unknown decision is rejected', () => {
    const queue = makeQueue()
    const { record } = createOne(queue)
    expect(() =>
      queue.resolve(record.id, {
        decision: 'maybe' as unknown as 'approve',
      }),
    ).toThrow(InvalidApprovalRequestError)
  })

  test('resolving an unknown id reports not-found', () => {
    const queue = makeQueue()
    expect(() => queue.resolve('nope', { decision: 'deny' })).toThrow(
      ApprovalRequestNotFoundError,
    )
  })

  test('amended terms replace the request, so the signature matches the record', () => {
    const queue = makeQueue()
    const { record } = createOne(queue)
    const amended = { ...OVER_POLICY, cap: '100000000' }
    const resolved = queue.resolve(record.id, {
      decision: 'approve',
      ownerSignature: SIGNATURE,
      approvedRequest: amended,
    })
    expect(resolved.request).toEqual(amended)
  })
})

describe('signature consumption', () => {
  test('a stored signature is removed after being marked consumed', () => {
    const queue = makeQueue()
    const { record } = createOne(queue)
    queue.resolve(record.id, { decision: 'approve', ownerSignature: SIGNATURE })

    const consumed = queue.markConsumed(record.id, {
      cardId: 'card-42',
      mintTxHash: TX_HASH,
    })

    expect(consumed.ownerSignature).toBeNull()
    expect(consumed.signatureConsumedAt).toBe(clock)
    expect(consumed.cardId).toBe('card-42')

    // Gone from SQLite, not merely hidden by the projection.
    const raw = db
      .prepare('SELECT owner_signature FROM approval_requests WHERE id = ?')
      .get(record.id) as { owner_signature: string | null }
    expect(raw.owner_signature).toBeNull()
  })

  test('the request stays approved so the agent can still find its card', () => {
    const queue = makeQueue()
    const { record } = createOne(queue)
    queue.resolve(record.id, { decision: 'approve', ownerSignature: SIGNATURE })
    queue.markConsumed(record.id, { cardId: 'card-42' })

    const status = queue.get(record.id)
    expect(status.status).toBe('approved')
    expect(status.cardId).toBe('card-42')
  })

  test('is idempotent, so a consumer that crashes mid-mint can retry', () => {
    const queue = makeQueue()
    const { record } = createOne(queue)
    queue.resolve(record.id, { decision: 'approve', ownerSignature: SIGNATURE })
    const first = queue.markConsumed(record.id, { cardId: 'card-42' })
    clock += 5_000
    const second = queue.markConsumed(record.id, {
      mintTxHash: OTHER_TX_HASH,
    })

    expect(second.signatureConsumedAt).toBe(first.signatureConsumedAt)
    expect(second.cardId).toBe('card-42')
    expect(second.mintTxHash).toBe(OTHER_TX_HASH)
  })

  test('a pending or denied request has no signature to consume', () => {
    const queue = makeQueue()
    const pending = createOne(queue).record
    expect(() => queue.markConsumed(pending.id)).toThrow(
      ApprovalRequestNotApprovedError,
    )

    const denied = createOne(queue).record
    queue.resolve(denied.id, { decision: 'deny' })
    expect(() => queue.markConsumed(denied.id)).toThrow(
      ApprovalRequestNotApprovedError,
    )
  })

  test('a malformed mint tx hash is refused', () => {
    const queue = makeQueue()
    const { record } = createOne(queue)
    queue.resolve(record.id, { decision: 'approve', ownerSignature: SIGNATURE })
    expect(() => queue.markConsumed(record.id, { mintTxHash: '0xbeef' })).toThrow(
      InvalidApprovalRequestError,
    )
  })
})

describe('list and stats', () => {
  test('defaults to the owner review list: pending only, newest first', () => {
    const queue = makeQueue()
    const first = createOne(queue).record
    clock += 1_000
    const second = createOne(queue).record
    clock += 1_000
    const denied = createOne(queue).record
    queue.resolve(denied.id, { decision: 'deny' })

    const pending = queue.list()
    expect(pending.map((r) => r.id)).toEqual([second.id, first.id])
  })

  test('filters by status and by session key', () => {
    const queue = makeQueue()
    createOne(queue)
    createOne(queue, { sessionKey: SESSION_B })

    expect(queue.list({ sessionKey: SESSION_B })).toHaveLength(1)
    expect(queue.list({ status: 'all' })).toHaveLength(2)
    expect(queue.list({ status: 'approved' })).toHaveLength(0)
  })

  test('expired requests drop out of the pending list without a sweep job', () => {
    const queue = makeQueue()
    createOne(queue, { ttlMs: MIN_TTL_MS })
    expect(queue.list()).toHaveLength(1)
    clock += MIN_TTL_MS
    expect(queue.list()).toHaveLength(0)
    expect(queue.list({ status: 'expired' })).toHaveLength(1)
  })

  test('stats reflect the derived statuses', () => {
    const queue = makeQueue()
    const approved = createOne(queue).record
    queue.resolve(approved.id, { decision: 'approve', ownerSignature: SIGNATURE })
    const denied = createOne(queue).record
    queue.resolve(denied.id, { decision: 'deny' })
    createOne(queue, { ttlMs: MIN_TTL_MS })
    createOne(queue)

    clock += MIN_TTL_MS
    expect(queue.stats()).toEqual({
      pending: 1,
      approved: 1,
      denied: 1,
      expired: 1,
    })
  })

  test('tryGet returns null instead of throwing for unknown ids', () => {
    const queue = makeQueue()
    expect(queue.tryGet('nope')).toBeNull()
    expect(queue.tryGet('')).toBeNull()
    expect(() => queue.get('nope')).toThrow(ApprovalRequestNotFoundError)
  })
})

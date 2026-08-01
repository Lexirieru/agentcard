import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Chain,
  type HttpTransport,
  type HttpTransportConfig,
  type PublicClient,
  type WalletClient,
} from 'viem'

import {
  GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL,
  GIWA_SEPOLIA_RPC_URL,
  giwaSepolia,
  giwaSepoliaFlashblocks,
} from './giwaSepolia.js'

/* -------------------------------------------------------------------------- */
/* Retry / backoff                                                            */
/* -------------------------------------------------------------------------- */

/**
 * HTTP statuses we treat as transient.
 *
 * 429 is the one the public GIWA endpoints actually hand out (both documented
 * as rate-limited, dev-only), 408/425 are request-timing failures, and 5xx are
 * gateway/sequencer hiccups. Every other 4xx is a client bug (bad params, bad
 * method, revert surfaced as a 4xx) and retrying it only burns rate budget.
 */
const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([
  408, 425, 429, 500, 502, 503, 504,
])

/** JSON-RPC error codes that mean "try again", not "you asked wrong". */
const RETRYABLE_RPC_CODES: ReadonlySet<number> = new Set([
  -32005, // limit exceeded (viem: LimitExceededRpcError)
  -32016, // provider-specific: request rate limit
])

/** Node/undici socket-level failures. */
const RETRYABLE_SYSCALL_CODES: ReadonlySet<string> = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

/** viem error classes that always mean "transient", regardless of payload. */
const RETRYABLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  'TimeoutError',
  'LimitExceededRpcError',
  'ResourceUnavailableRpcError',
])

/** Messages that unambiguously mean "the request never got a real answer". */
const RETRYABLE_MESSAGE_PATTERNS: readonly RegExp[] = [
  /fetch failed/i,
  /socket hang ?up/i,
  /network (error|request failed)/i,
  /timed? ?out/i,
  /timeout/i,
  /rate ?limit/i,
  /too many requests/i,
  /service unavailable/i,
  /bad gateway/i,
  /connection (reset|closed|refused)/i,
]

/**
 * Errors that must never be retried even if something further down the cause
 * chain looks transient: a revert is deterministic, and a rejected signature is
 * a human decision.
 */
const TERMINAL_ERROR_NAMES: ReadonlySet<string> = new Set([
  'ContractFunctionRevertedError',
  'ContractFunctionZeroDataError',
  'UserRejectedRequestError',
  'InvalidInputRpcError',
  'InvalidParamsRpcError',
  'MethodNotFoundRpcError',
  'MethodNotSupportedRpcError',
  'AbiFunctionNotFoundError',
])

const TERMINAL_MESSAGE_PATTERNS: readonly RegExp[] = [
  /execution reverted/i,
  /revert(ed)?\b/i,
  /user (rejected|denied)/i,
  /insufficient funds/i,
  /nonce too low/i,
  /already known/i,
]

type ErrorLike = {
  name?: unknown
  message?: unknown
  status?: unknown
  code?: unknown
  headers?: unknown
  cause?: unknown
}

/** Flatten an error's `cause` chain (bounded, so a cycle cannot hang us). */
function causeChain(error: unknown, maxDepth = 8): ErrorLike[] {
  const chain: ErrorLike[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && chain.length < maxDepth) {
    if (seen.has(current)) break
    seen.add(current)
    chain.push(current as ErrorLike)
    current = (current as ErrorLike).cause
  }
  return chain
}

function messageOf(node: ErrorLike): string {
  const parts: string[] = []
  if (typeof node.name === 'string') parts.push(node.name)
  if (typeof node.message === 'string') parts.push(node.message)
  if (typeof (node as { shortMessage?: unknown }).shortMessage === 'string') {
    parts.push((node as { shortMessage: string }).shortMessage)
  }
  if (typeof (node as { details?: unknown }).details === 'string') {
    parts.push((node as { details: string }).details)
  }
  return parts.join(' ')
}

/**
 * Decide whether an RPC failure is worth another attempt.
 *
 * Order matters: terminal signals win over transient ones, then explicit HTTP
 * status, then JSON-RPC code, then socket code, then message shape. Anything
 * unrecognised is treated as non-transient — retrying an unknown failure
 * against a rate-limited public endpoint is worse than failing fast.
 */
export function isTransientRpcError(error: unknown): boolean {
  if (typeof error === 'string') {
    return RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(error))
  }
  const chain = causeChain(error)
  if (chain.length === 0) return false

  // 1. Terminal signals anywhere in the chain.
  for (const node of chain) {
    if (typeof node.name === 'string' && TERMINAL_ERROR_NAMES.has(node.name)) {
      return false
    }
    const text = messageOf(node)
    if (TERMINAL_MESSAGE_PATTERNS.some((pattern) => pattern.test(text))) {
      // "timeout" never appears in a revert message, so this is safe to treat
      // as decisive.
      return false
    }
  }

  // 2. Error classes that are transient by construction.
  for (const node of chain) {
    if (typeof node.name === 'string' && RETRYABLE_ERROR_NAMES.has(node.name)) {
      return true
    }
  }

  // 3. HTTP status.
  for (const node of chain) {
    if (typeof node.status === 'number') {
      return RETRYABLE_HTTP_STATUS.has(node.status)
    }
  }

  // 4. JSON-RPC code (numeric) / socket code (string).
  for (const node of chain) {
    if (typeof node.code === 'number') {
      return RETRYABLE_RPC_CODES.has(node.code)
    }
    if (
      typeof node.code === 'string' &&
      RETRYABLE_SYSCALL_CODES.has(node.code)
    ) {
      return true
    }
  }

  // 5. Message shape.
  return chain.some((node) =>
    RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(messageOf(node))),
  )
}

/** Thrown when every retry attempt has been used up. */
export class RpcRetryLimitError extends Error {
  override readonly name = 'RpcRetryLimitError'
  readonly attempts: number

  constructor(
    message: string,
    options: { attempts: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause })
    this.attempts = options.attempts
  }
}

export interface RetryInfo {
  /** 1-based index of the attempt that just failed. */
  attempt: number
  /** Delay before the next attempt, in milliseconds. */
  delayMs: number
  error: unknown
}

export interface RetryOptions {
  /** Total attempts, including the first. Default 4. */
  maxAttempts?: number
  /** Delay before the 2nd attempt; doubles each time. Default 250ms. */
  baseDelayMs?: number
  /** Upper bound on any single delay. Default 8000ms. */
  maxDelayMs?: number
  /** Randomise delays into [50%, 100%] of the computed value. Default true. */
  jitter?: boolean
  /** Honour a `Retry-After` header when the endpoint sends one. Default true. */
  respectRetryAfter?: boolean
  /** Abort between attempts. */
  signal?: AbortSignal
  /** Called after a failed attempt that will be retried. */
  onRetry?: (info: RetryInfo) => void
  /** Override the transient/terminal classification. */
  isTransient?: (error: unknown) => boolean
  /** Injected for tests, so the suite never actually waits. */
  sleep?: (ms: number) => Promise<void>
  /** Injected for tests, so jitter is deterministic. */
  random?: () => number
}

export const DEFAULT_RETRY_OPTIONS = {
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  jitter: true,
  respectRetryAfter: true,
} as const

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Parse `Retry-After` (seconds, or an HTTP date) out of an error, in ms. */
export function retryAfterMs(error: unknown, now = Date.now()): number | null {
  for (const node of causeChain(error)) {
    const headers = node.headers
    let raw: string | null = null
    if (headers && typeof (headers as Headers).get === 'function') {
      raw = (headers as Headers).get('retry-after')
    } else if (headers && typeof headers === 'object') {
      const record = headers as Record<string, unknown>
      const value = record['retry-after'] ?? record['Retry-After']
      if (typeof value === 'string' || typeof value === 'number') {
        raw = String(value)
      }
    }
    if (raw === null || raw.trim() === '') continue

    const seconds = Number(raw)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)

    const date = Date.parse(raw)
    if (Number.isFinite(date)) return Math.max(0, date - now)
  }
  return null
}

function backoffDelay(
  attempt: number,
  options: {
    baseDelayMs: number
    maxDelayMs: number
    jitter: boolean
    random: () => number
  },
): number {
  const exponential = options.baseDelayMs * 2 ** (attempt - 1)
  const capped = Math.min(exponential, options.maxDelayMs)
  if (!options.jitter) return capped
  // Half jitter: keeps a sane floor while still de-correlating retries.
  return Math.round(capped * (0.5 + options.random() * 0.5))
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * Run an RPC call with exponential backoff on transient failures.
 *
 * Both public GIWA endpoints are documented as rate-limited and dev-only, so
 * every read path in this package should go through here rather than trusting a
 * single shot. Terminal errors (reverts, bad params) propagate untouched on the
 * first attempt.
 */
export async function withRpcRetry<T>(
  fn: (attempt: number) => Promise<T> | T,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_RETRY_OPTIONS.maxAttempts
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError(
      `withRpcRetry: maxAttempts must be a positive integer, got ${String(
        options.maxAttempts,
      )}`,
    )
  }
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_OPTIONS.baseDelayMs
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY_OPTIONS.maxDelayMs
  const jitter = options.jitter ?? DEFAULT_RETRY_OPTIONS.jitter
  const respectRetryAfter =
    options.respectRetryAfter ?? DEFAULT_RETRY_OPTIONS.respectRetryAfter
  const isTransient = options.isTransient ?? isTransientRpcError
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random

  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    options.signal?.throwIfAborted()
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = error
      if (!isTransient(error)) throw error
      if (attempt === maxAttempts) break

      let delayMs = backoffDelay(attempt, {
        baseDelayMs,
        maxDelayMs,
        jitter,
        random,
      })
      if (respectRetryAfter) {
        const serverDelay = retryAfterMs(error)
        if (serverDelay !== null) {
          delayMs = Math.min(Math.max(delayMs, serverDelay), maxDelayMs)
        }
      }

      options.onRetry?.({ attempt, delayMs, error })
      await sleep(delayMs)
    }
  }

  throw new RpcRetryLimitError(
    `GIWA RPC request failed after ${maxAttempts} attempt(s). ` +
      `Both public GIWA Sepolia endpoints are rate-limited; slow down or use a dedicated RPC. ` +
      `Last error — ${describeError(lastError)}`,
    { attempts: maxAttempts, cause: lastError },
  )
}

/**
 * Actions that must never be retried automatically: a retried submit can
 * broadcast the same intent twice, and a retried signature request re-prompts
 * the owner. Callers who want these retried must opt in explicitly with
 * {@link withRpcRetry}.
 */
const NON_RETRYABLE_ACTIONS: ReadonlySet<string> = new Set([
  'sendTransaction',
  'sendRawTransaction',
  'writeContract',
  'deployContract',
  'signTransaction',
  'signMessage',
  'signTypedData',
  'request',
  'extend',
])

/**
 * Wrap every read action on a viem client so it retries with backoff.
 *
 * Write actions are passed through untouched (see {@link NON_RETRYABLE_ACTIONS}).
 */
export function withRetryingActions<client extends object>(
  client: client,
  options: RetryOptions = {},
): client {
  const cache = new Map<string | symbol, unknown>()
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      if (typeof property === 'string' && NON_RETRYABLE_ACTIONS.has(property)) {
        return value
      }
      if (cache.has(property)) return cache.get(property)
      const wrapped = (...args: unknown[]) =>
        withRpcRetry(
          () => (value as (...a: unknown[]) => unknown).apply(target, args),
          options,
        )
      cache.set(property, wrapped)
      return wrapped
    },
  })
}

/* -------------------------------------------------------------------------- */
/* Transports + clients                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `blockTag` for reads that want Flashblocks preconfirmation state.
 *
 * KTD-5: use this only to make the UI feel instant. Onchain (safe-block) state
 * is what decides whether a card is real.
 */
export const PRECONFIRMATION_BLOCK_TAG = 'pending' as const

export interface GiwaTransportOptions extends HttpTransportConfig {
  /** Override the endpoint (a dedicated/paid RPC, or a local devnet). */
  url?: string
}

/**
 * viem's http transport does its own internal retrying. We disable it and let
 * {@link withRpcRetry} own the policy, so backoff, jitter and `Retry-After` are
 * decided in exactly one place.
 */
function createTransport(
  defaultUrl: string,
  options: GiwaTransportOptions = {},
): HttpTransport {
  const { url, ...config } = options
  return http(url ?? defaultUrl, {
    retryCount: 0,
    timeout: 20_000,
    ...config,
  })
}

/** Standard RPC transport (everything that is not a preconfirmation read). */
export function giwaTransport(options: GiwaTransportOptions = {}): HttpTransport {
  return createTransport(GIWA_SEPOLIA_RPC_URL, options)
}

/** Flashblocks RPC transport (preconfirmation reads only). */
export function giwaFlashblocksTransport(
  options: GiwaTransportOptions = {},
): HttpTransport {
  return createTransport(GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL, options)
}

export interface GiwaClientOptions {
  transport?: GiwaTransportOptions
  /** Retry policy for read actions. Pass `false` to opt out entirely. */
  retry?: RetryOptions | false
  /** Override the chain (e.g. a forked local chain in tests). */
  chain?: Chain
  pollingInterval?: number
}

export type GiwaPublicClient = PublicClient<HttpTransport, Chain>
export type GiwaWalletClient = WalletClient<HttpTransport, Chain, Account>

function applyRetry<client extends object>(
  client: client,
  retry: RetryOptions | false | undefined,
): client {
  if (retry === false) return client
  return withRetryingActions(client, retry ?? {})
}

/** Public client on the standard RPC. This is the default for everything. */
export function createGiwaPublicClient(
  options: GiwaClientOptions = {},
): GiwaPublicClient {
  const client = createPublicClient({
    chain: options.chain ?? giwaSepolia,
    transport: giwaTransport(options.transport),
    ...(options.pollingInterval !== undefined
      ? { pollingInterval: options.pollingInterval }
      : {}),
  }) as GiwaPublicClient
  return applyRetry(client, options.retry)
}

/**
 * Public client on the Flashblocks RPC.
 *
 * Pair it with `blockTag: PRECONFIRMATION_BLOCK_TAG` on reads — without that
 * tag you get the same latest block the standard endpoint would give you.
 */
export function createGiwaFlashblocksClient(
  options: GiwaClientOptions = {},
): GiwaPublicClient {
  const client = createPublicClient({
    chain: options.chain ?? giwaSepoliaFlashblocks,
    transport: giwaFlashblocksTransport(options.transport),
    ...(options.pollingInterval !== undefined
      ? { pollingInterval: options.pollingInterval }
      : {}),
  }) as GiwaPublicClient
  return applyRetry(client, options.retry)
}

export interface GiwaWalletClientOptions extends GiwaClientOptions {
  account: Account
}

/**
 * Wallet client on the standard RPC.
 *
 * Writes are never auto-retried (see {@link NON_RETRYABLE_ACTIONS}); reads that
 * ride along on the wallet client still are.
 */
export function createGiwaWalletClient(
  options: GiwaWalletClientOptions,
): GiwaWalletClient {
  const client = createWalletClient({
    account: options.account,
    chain: options.chain ?? giwaSepolia,
    transport: giwaTransport(options.transport),
    ...(options.pollingInterval !== undefined
      ? { pollingInterval: options.pollingInterval }
      : {}),
  }) as GiwaWalletClient
  return applyRetry(client, options.retry)
}

export interface GiwaClients {
  chain: Chain
  /** Standard RPC. Source of truth. */
  publicClient: GiwaPublicClient
  /** Flashblocks RPC. Preconfirmation reads only (KTD-5). */
  flashblocksClient: GiwaPublicClient
}

/** Both read clients at once, which is what callers almost always want. */
export function createGiwaClients(options: GiwaClientOptions = {}): GiwaClients {
  return {
    chain: options.chain ?? giwaSepolia,
    publicClient: createGiwaPublicClient(options),
    flashblocksClient: createGiwaFlashblocksClient(options),
  }
}

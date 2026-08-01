/**
 * GIWA Sepolia chain definition and viem clients for the merchant service.
 *
 * `merchant/` is a standalone service, not a consumer of the `giwacard` npm
 * package, so the chain definition is copied here rather than imported. The
 * values are byte-for-byte the ones in `giwacard/src/chain/giwaSepolia.ts` and
 * must stay that way — `chain.test.ts` pins them.
 *
 * The retry/backoff policy mirrors `giwacard/src/chain/clients.ts`: both public
 * GIWA endpoints are documented as rate-limited and dev-only, so every read goes
 * through exponential backoff with jitter and `Retry-After` support.
 *
 * KTD-9: the merchant *settles* — `CardVault.charge` pays `msg.sender` and
 * demands `msg.sender == card.merchantScope`, so the merchant is the one who
 * runs the card. This module therefore builds two clients: a read-only public
 * client for reports and receipts, and a wallet client bound to the merchant's
 * funded key for the one write the service performs. The retry wrapper below
 * deliberately does **not** cover writes: see `NON_RETRYABLE_ACTIONS`.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Account,
  type Chain,
  type Hex,
  type HttpTransport,
  type HttpTransportConfig,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { chainConfig } from 'viem/op-stack'

/* -------------------------------------------------------------------------- */
/* Chain definition                                                           */
/* -------------------------------------------------------------------------- */

const sourceId = 11_155_111 // sepolia

/** Chain ID of GIWA Sepolia. */
export const GIWA_SEPOLIA_ID = 91_342 as const

/** CAIP-ish network slug advertised in x402 payment requirements. */
export const GIWA_SEPOLIA_NETWORK = 'giwa-sepolia' as const

/** Public, rate-limited standard RPC. Dev/testnet use only. */
export const GIWA_SEPOLIA_RPC_URL = 'https://sepolia-rpc.giwa.io' as const

/**
 * Public, rate-limited Flashblocks RPC. Serves preconfirmation state via
 * `blockTag: 'pending'` roughly every 200ms, ahead of the sequencer block.
 */
export const GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL =
  'https://sepolia-rpc-flashblocks.giwa.io' as const

/** Blockscout explorer. The REST API lives under the `/api` suffix. */
export const GIWA_SEPOLIA_EXPLORER_URL =
  'https://sepolia-explorer.giwa.io' as const

/** Blockscout REST/verification API base (the `/api` suffix is mandatory). */
export const GIWA_SEPOLIA_EXPLORER_API_URL =
  'https://sepolia-explorer.giwa.io/api' as const

/** Advertised Flashblocks preconfirmation interval, in milliseconds. */
export const GIWA_SEPOLIA_PRECONFIRMATION_TIME_MS = 200 as const

/**
 * GIWA Sepolia (chain ID 91342), the OP Stack testnet this service settles on.
 *
 * Spreads `chainConfig` from `viem/op-stack` so deposit-transaction formatters,
 * serializers and the standard L2 predeploys come along — the merchant's
 * insights report counts OP Stack deposit transactions, which needs the
 * formatter to name the `0x7e` type.
 */
export const giwaSepolia = /*#__PURE__*/ defineChain({
  ...chainConfig,
  id: GIWA_SEPOLIA_ID,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [GIWA_SEPOLIA_RPC_URL],
    },
    flashblocks: {
      http: [GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL],
    },
  },
  blockExplorers: {
    default: {
      name: 'GIWA Sepolia Explorer',
      url: GIWA_SEPOLIA_EXPLORER_URL,
      apiUrl: GIWA_SEPOLIA_EXPLORER_API_URL,
    },
  },
  contracts: {
    ...chainConfig.contracts,
  },
  testnet: true,
  sourceId,
})

/** Explorer link helpers, so nothing downstream hand-builds explorer URLs. */
export const giwaSepoliaExplorer = {
  tx: (hash: string) => `${GIWA_SEPOLIA_EXPLORER_URL}/tx/${hash}`,
  address: (address: string) =>
    `${GIWA_SEPOLIA_EXPLORER_URL}/address/${address}`,
  block: (block: bigint | number | string) =>
    `${GIWA_SEPOLIA_EXPLORER_URL}/block/${block}`,
} as const

/* -------------------------------------------------------------------------- */
/* Retry / backoff                                                            */
/* -------------------------------------------------------------------------- */

/**
 * HTTP statuses we treat as transient.
 *
 * 429 is the one the public GIWA endpoints actually hand out, 408/425 are
 * request-timing failures, and 5xx are gateway/sequencer hiccups. Every other
 * 4xx is a client bug and retrying it only burns rate budget.
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
 * chain looks transient: a revert is deterministic, and a missing receipt is an
 * answer, not a failure.
 */
const TERMINAL_ERROR_NAMES: ReadonlySet<string> = new Set([
  'ContractFunctionRevertedError',
  'ContractFunctionZeroDataError',
  'InvalidInputRpcError',
  'InvalidParamsRpcError',
  'MethodNotFoundRpcError',
  'MethodNotSupportedRpcError',
  'AbiFunctionNotFoundError',
  'TransactionReceiptNotFoundError',
  'BlockNotFoundError',
])

const TERMINAL_MESSAGE_PATTERNS: readonly RegExp[] = [
  /execution reverted/i,
  /revert(ed)?\b/i,
  /could not be found/i,
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
  /** Number of attempts made before giving up. */
  readonly attempts: number

  constructor(message: string, options: { attempts: number; cause?: unknown }) {
    super(message, { cause: options.cause })
    this.attempts = options.attempts
  }
}

/** Detail handed to {@link RetryOptions.onRetry} after a failed attempt. */
export interface RetryInfo {
  /** 1-based index of the attempt that just failed. */
  attempt: number
  /** Delay before the next attempt, in milliseconds. */
  delayMs: number
  /** The error that caused the retry. */
  error: unknown
}

/** Knobs for {@link withRpcRetry}. All optional; the defaults are sane. */
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

/** Defaults applied by {@link withRpcRetry} when an option is omitted. */
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
 * Terminal errors (reverts, bad params, "receipt not found") propagate untouched
 * on the first attempt — a facilitator that retried "no such transaction" would
 * just make an honest 402 slow.
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
 * Actions that must never be retried automatically.
 *
 * This list stopped being theoretical when the merchant grew a key. Silently
 * re-sending `writeContract` after a timeout is how one intended charge becomes
 * two broadcast transactions competing for the same nonce; the vault would
 * reject the second (the card is `Used`), but the merchant would still have paid
 * gas for it and the failure would look like a mystery. A settlement is retried
 * by a *client* presenting its card again, never by this transport.
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
 * Write actions are passed through untouched (see `NON_RETRYABLE_ACTIONS`).
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
/* Transport + client                                                         */
/* -------------------------------------------------------------------------- */

/** Transport overrides, e.g. a dedicated RPC or a local devnet. */
export interface MerchantTransportOptions extends HttpTransportConfig {
  /** Override the endpoint. */
  url?: string
}

/**
 * viem's http transport does its own internal retrying. We disable it and let
 * {@link withRpcRetry} own the policy, so backoff, jitter and `Retry-After` are
 * decided in exactly one place.
 */
export function merchantTransport(
  options: MerchantTransportOptions = {},
): HttpTransport {
  const { url, ...config } = options
  return http(url ?? GIWA_SEPOLIA_RPC_URL, {
    retryCount: 0,
    timeout: 20_000,
    ...config,
  })
}

/** Options for {@link createMerchantPublicClient} and its wallet counterpart. */
export interface MerchantClientOptions {
  transport?: MerchantTransportOptions
  /** Retry policy for read actions. Pass `false` to opt out entirely. */
  retry?: RetryOptions | false
  /** Override the chain (e.g. a forked local chain). */
  chain?: Chain
  pollingInterval?: number
}

/** The read client: no account, so it cannot spend anything. */
export type MerchantPublicClient = PublicClient<HttpTransport, Chain>

/**
 * Read-only public client on the standard GIWA Sepolia RPC.
 *
 * KTD-5: the merchant reads the *sequencer* block (`latest`), not the safe
 * block, and not the Flashblocks preconfirmation endpoint. See `verify.ts` for
 * why, and what risk that accepts.
 */
export function createMerchantPublicClient(
  options: MerchantClientOptions = {},
): MerchantPublicClient {
  const client = createPublicClient({
    chain: options.chain ?? giwaSepolia,
    transport: merchantTransport(options.transport),
    ...(options.pollingInterval !== undefined
      ? { pollingInterval: options.pollingInterval }
      : {}),
  }) as MerchantPublicClient
  if (options.retry === false) return client
  return withRetryingActions(client, options.retry ?? {})
}

/** The write client: bound to the merchant account, able to charge a card. */
export type MerchantWalletClient = WalletClient<HttpTransport, Chain, Account>

/** Options for {@link createMerchantWalletClient}. */
export interface MerchantWalletClientOptions extends MerchantClientOptions {
  /** The merchant's 32-byte signing key, already validated by `config.ts`. */
  privateKey: Hex
}

/**
 * Wallet client bound to the merchant's funded account.
 *
 * Built once, at wiring time, and handed straight to the facilitator's
 * {@link import('./verify.js').ChargeSubmitter} — nothing else in the service
 * receives it. `withRetryingActions` is applied for parity with the read client,
 * but it passes `writeContract` and every signing action through untouched (see
 * `NON_RETRYABLE_ACTIONS`), so a timed-out charge is never silently re-sent.
 */
export function createMerchantWalletClient(
  options: MerchantWalletClientOptions,
): MerchantWalletClient {
  const client = createWalletClient({
    account: privateKeyToAccount(options.privateKey),
    chain: options.chain ?? giwaSepolia,
    transport: merchantTransport(options.transport),
  }) as MerchantWalletClient
  if (options.retry === false) return client
  return withRetryingActions(client, options.retry ?? {})
}

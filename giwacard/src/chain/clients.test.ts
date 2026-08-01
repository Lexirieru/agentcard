import { describe, expect, test } from 'bun:test'
import { HttpRequestError, RpcRequestError, TimeoutError } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import {
  DEFAULT_RETRY_OPTIONS,
  PRECONFIRMATION_BLOCK_TAG,
  RpcRetryLimitError,
  createGiwaClients,
  createGiwaFlashblocksClient,
  createGiwaPublicClient,
  createGiwaWalletClient,
  giwaFlashblocksTransport,
  giwaTransport,
  isTransientRpcError,
  retryAfterMs,
  withRetryingActions,
  withRpcRetry,
  type RetryInfo,
} from './clients.js'
import {
  GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL,
  GIWA_SEPOLIA_RPC_URL,
} from './giwaSepolia.js'

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const body = { method: 'eth_blockNumber', params: [] }

function httpError(status: number, headers?: Record<string, string>) {
  return new HttpRequestError({
    body,
    details: `Status ${status}`,
    headers: headers ? new Headers(headers) : undefined,
    status,
    url: GIWA_SEPOLIA_RPC_URL,
  })
}

/** Collects the delays a run would have slept, without sleeping. */
function fakeClock() {
  const delays: number[] = []
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms)
    },
  }
}

/** No jitter + deterministic random keeps the delay assertions exact. */
const deterministic = { jitter: false as const, random: () => 0.5 }

/* -------------------------------------------------------------------------- */
/* isTransientRpcError                                                        */
/* -------------------------------------------------------------------------- */

describe('isTransientRpcError', () => {
  test('429 is transient — this is the one the public GIWA RPCs hand out', () => {
    expect(isTransientRpcError(httpError(429))).toBe(true)
  })

  test('5xx and request-timing statuses are transient', () => {
    for (const status of [408, 425, 500, 502, 503, 504]) {
      expect(isTransientRpcError(httpError(status))).toBe(true)
    }
  })

  test('other 4xx are NOT transient', () => {
    for (const status of [400, 401, 403, 404, 405, 422]) {
      expect(isTransientRpcError(httpError(status))).toBe(false)
    }
  })

  test('a revert is never retried', () => {
    const reverted = new RpcRequestError({
      body,
      error: { code: 3, message: 'execution reverted: CardAlreadyUsed()' },
      url: GIWA_SEPOLIA_RPC_URL,
    })
    expect(isTransientRpcError(reverted)).toBe(false)
  })

  test('a revert wrapped in a transient-looking envelope is still not retried', () => {
    const wrapper = new Error('request failed')
    wrapper.cause = new Error('execution reverted: InsufficientAvailable()')
    expect(isTransientRpcError(wrapper)).toBe(false)
  })

  test('a rate-limit JSON-RPC code is transient', () => {
    const limited = new RpcRequestError({
      body,
      error: { code: -32005, message: 'limit exceeded' },
      url: GIWA_SEPOLIA_RPC_URL,
    })
    expect(isTransientRpcError(limited)).toBe(true)
  })

  test('viem TimeoutError is transient', () => {
    expect(
      isTransientRpcError(new TimeoutError({ body, url: GIWA_SEPOLIA_RPC_URL })),
    ).toBe(true)
  })

  test('socket-level failures are transient', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED']) {
      const error = new TypeError('fetch failed')
      error.cause = Object.assign(new Error('socket'), { code })
      expect(isTransientRpcError(error)).toBe(true)
    }
  })

  test('undici "fetch failed" is transient even without a code', () => {
    expect(isTransientRpcError(new TypeError('fetch failed'))).toBe(true)
  })

  test('a user rejection is never retried', () => {
    expect(
      isTransientRpcError(new Error('User rejected the request.')),
    ).toBe(false)
  })

  test('unknown errors are not retried (fail fast on a rate-limited endpoint)', () => {
    expect(isTransientRpcError(new Error('something odd'))).toBe(false)
    expect(isTransientRpcError(undefined)).toBe(false)
    expect(isTransientRpcError(null)).toBe(false)
    expect(isTransientRpcError(42)).toBe(false)
  })

  test('does not follow a cyclic cause chain forever', () => {
    const a = new Error('a')
    const b = new Error('b')
    a.cause = b
    b.cause = a
    expect(isTransientRpcError(a)).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* retryAfterMs                                                               */
/* -------------------------------------------------------------------------- */

describe('retryAfterMs', () => {
  test('reads a seconds-valued Retry-After header', () => {
    expect(retryAfterMs(httpError(429, { 'retry-after': '2' }))).toBe(2000)
  })

  test('reads an HTTP-date Retry-After header', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0)
    const later = new Date(now + 5000).toUTCString()
    expect(retryAfterMs(httpError(429, { 'retry-after': later }), now)).toBe(
      5000,
    )
  })

  test('returns null when the header is absent', () => {
    expect(retryAfterMs(httpError(429))).toBeNull()
    expect(retryAfterMs(new Error('nope'))).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* withRpcRetry                                                               */
/* -------------------------------------------------------------------------- */

describe('withRpcRetry', () => {
  test('returns immediately when the call succeeds', async () => {
    let calls = 0
    const result = await withRpcRetry(async () => {
      calls++
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(calls).toBe(1)
  })

  test('retries a simulated 429 and then succeeds', async () => {
    const clock = fakeClock()
    let calls = 0
    const result = await withRpcRetry(
      async () => {
        calls++
        if (calls < 3) throw httpError(429)
        return 12345n
      },
      { ...deterministic, sleep: clock.sleep, baseDelayMs: 100 },
    )
    expect(result).toBe(12345n)
    expect(calls).toBe(3)
    expect(clock.delays).toEqual([100, 200])
  })

  test('backs off exponentially and respects maxDelayMs', async () => {
    const clock = fakeClock()
    await withRpcRetry(
      async (attempt) => {
        if (attempt < 5) throw httpError(503)
        return 'ok'
      },
      {
        ...deterministic,
        sleep: clock.sleep,
        baseDelayMs: 100,
        maxDelayMs: 350,
        maxAttempts: 5,
      },
    )
    expect(clock.delays).toEqual([100, 200, 350, 350])
  })

  test('jitter keeps delays within [50%, 100%] of the computed backoff', async () => {
    const clock = fakeClock()
    await withRpcRetry(
      async (attempt) => {
        if (attempt < 3) throw httpError(429)
        return 'ok'
      },
      { sleep: clock.sleep, baseDelayMs: 1000, jitter: true, random: () => 0 },
    )
    expect(clock.delays).toEqual([500, 1000])
  })

  test('honours a Retry-After header when it is longer than the backoff', async () => {
    const clock = fakeClock()
    await withRpcRetry(
      async (attempt) => {
        if (attempt < 2) throw httpError(429, { 'retry-after': '3' })
        return 'ok'
      },
      { ...deterministic, sleep: clock.sleep, baseDelayMs: 100 },
    )
    expect(clock.delays).toEqual([3000])
  })

  test('never sleeps longer than maxDelayMs, even if the server asks for it', async () => {
    const clock = fakeClock()
    await withRpcRetry(
      async (attempt) => {
        if (attempt < 2) throw httpError(429, { 'retry-after': '600' })
        return 'ok'
      },
      { ...deterministic, sleep: clock.sleep, maxDelayMs: 5000 },
    )
    expect(clock.delays).toEqual([5000])
  })

  test('gives up after maxAttempts with a clear, typed error', async () => {
    const clock = fakeClock()
    let calls = 0
    const promise = withRpcRetry(
      async () => {
        calls++
        throw httpError(429)
      },
      { ...deterministic, sleep: clock.sleep, maxAttempts: 3 },
    )

    await expect(promise).rejects.toThrow(RpcRetryLimitError)
    expect(calls).toBe(3)
    expect(clock.delays).toHaveLength(2)

    let caught: unknown
    try {
      await withRpcRetry(
        async () => {
          throw httpError(429)
        },
        { ...deterministic, sleep: clock.sleep, maxAttempts: 3 },
      )
    } catch (error) {
      caught = error
    }
    const error = caught as RpcRetryLimitError
    expect(error.name).toBe('RpcRetryLimitError')
    expect(error.attempts).toBe(3)
    expect(error.message).toContain('3 attempt(s)')
    expect(error.message).toContain('rate-limited')
    expect(error.cause).toBeInstanceOf(HttpRequestError)
  })

  test('does NOT retry a non-transient error — it rethrows the original', async () => {
    let calls = 0
    const original = httpError(400)
    const clock = fakeClock()

    let caught: unknown
    try {
      await withRpcRetry(
        async () => {
          calls++
          throw original
        },
        { sleep: clock.sleep },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(original)
    expect(caught).not.toBeInstanceOf(RpcRetryLimitError)
    expect(calls).toBe(1)
    expect(clock.delays).toEqual([])
  })

  test('does NOT retry a revert', async () => {
    let calls = 0
    const reverted = new RpcRequestError({
      body,
      error: { code: 3, message: 'execution reverted: MerchantNotAllowed()' },
      url: GIWA_SEPOLIA_RPC_URL,
    })
    await expect(
      withRpcRetry(
        async () => {
          calls++
          throw reverted
        },
        { sleep: fakeClock().sleep },
      ),
    ).rejects.toBe(reverted)
    expect(calls).toBe(1)
  })

  test('reports each retry through onRetry', async () => {
    const seen: RetryInfo[] = []
    await withRpcRetry(
      async (attempt) => {
        if (attempt < 3) throw httpError(429)
        return 'ok'
      },
      {
        ...deterministic,
        sleep: fakeClock().sleep,
        baseDelayMs: 10,
        onRetry: (info) => seen.push(info),
      },
    )
    expect(seen.map((s) => s.attempt)).toEqual([1, 2])
    expect(seen.map((s) => s.delayMs)).toEqual([10, 20])
    expect(seen[0]?.error).toBeInstanceOf(HttpRequestError)
  })

  test('a custom isTransient predicate overrides the default classification', async () => {
    let calls = 0
    const result = await withRpcRetry(
      async () => {
        calls++
        if (calls < 2) throw new Error('totally unknown failure')
        return 'ok'
      },
      { sleep: fakeClock().sleep, isTransient: () => true, jitter: false },
    )
    expect(result).toBe('ok')
    expect(calls).toBe(2)
  })

  test('an aborted signal stops the loop', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      withRpcRetry(async () => 'never', { signal: controller.signal }),
    ).rejects.toThrow()
  })

  test('maxAttempts: 1 means no retries at all', async () => {
    let calls = 0
    await expect(
      withRpcRetry(
        async () => {
          calls++
          throw httpError(429)
        },
        { maxAttempts: 1, sleep: fakeClock().sleep },
      ),
    ).rejects.toThrow(RpcRetryLimitError)
    expect(calls).toBe(1)
  })

  test('rejects a nonsensical maxAttempts', async () => {
    await expect(
      withRpcRetry(async () => 'ok', { maxAttempts: 0 }),
    ).rejects.toThrow(TypeError)
    await expect(
      withRpcRetry(async () => 'ok', { maxAttempts: -1 }),
    ).rejects.toThrow(TypeError)
  })

  test('has sane defaults', () => {
    expect(DEFAULT_RETRY_OPTIONS.maxAttempts).toBe(4)
    expect(DEFAULT_RETRY_OPTIONS.baseDelayMs).toBe(250)
    expect(DEFAULT_RETRY_OPTIONS.jitter).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* withRetryingActions                                                        */
/* -------------------------------------------------------------------------- */

describe('withRetryingActions', () => {
  test('retries read actions', async () => {
    let calls = 0
    const clock = fakeClock()
    const client = {
      getBlockNumber: async () => {
        calls++
        if (calls < 3) throw httpError(429)
        return 99n
      },
    }
    const wrapped = withRetryingActions(client, {
      ...deterministic,
      sleep: clock.sleep,
      baseDelayMs: 1,
    })
    expect(await wrapped.getBlockNumber()).toBe(99n)
    expect(calls).toBe(3)
  })

  test('does NOT retry write actions — a resubmit could double-spend', async () => {
    let calls = 0
    const client = {
      sendTransaction: async () => {
        calls++
        throw httpError(429)
      },
      writeContract: async () => {
        calls++
        throw httpError(429)
      },
    }
    const wrapped = withRetryingActions(client, { sleep: fakeClock().sleep })

    await expect(wrapped.sendTransaction()).rejects.toThrow(HttpRequestError)
    await expect(wrapped.writeContract()).rejects.toThrow(HttpRequestError)
    expect(calls).toBe(2)
  })

  test('passes non-function properties straight through', () => {
    const client = { chain: { id: 91_342 }, uid: 'abc' }
    const wrapped = withRetryingActions(client)
    expect(wrapped.chain.id).toBe(91_342)
    expect(wrapped.uid).toBe('abc')
  })

  test('returns a stable function identity per property', () => {
    const client = { getBalance: async () => 0n }
    const wrapped = withRetryingActions(client)
    expect(wrapped.getBalance).toBe(wrapped.getBalance)
  })
})

/* -------------------------------------------------------------------------- */
/* Transports + clients                                                       */
/* -------------------------------------------------------------------------- */

describe('transports', () => {
  test('the default transport points at the standard RPC', () => {
    const transport = giwaTransport()({})
    expect(transport.value?.['url']).toBe(GIWA_SEPOLIA_RPC_URL)
  })

  test('the flashblocks transport points at the flashblocks RPC', () => {
    const transport = giwaFlashblocksTransport()({})
    expect(transport.value?.['url']).toBe(GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL)
  })

  test('a custom url overrides the default', () => {
    const transport = giwaTransport({ url: 'http://127.0.0.1:8545' })({})
    expect(transport.value?.['url']).toBe('http://127.0.0.1:8545')
  })

  test('viem internal retrying is disabled so backoff lives in one place', () => {
    expect(giwaTransport()({}).config.retryCount).toBe(0)
    expect(giwaFlashblocksTransport()({}).config.retryCount).toBe(0)
  })
})

describe('clients', () => {
  test('the public client is on GIWA Sepolia via the standard RPC', () => {
    const client = createGiwaPublicClient()
    expect(client.chain.id).toBe(91_342)
    expect(client.transport['url']).toBe(GIWA_SEPOLIA_RPC_URL)
  })

  test('the flashblocks client is on the same chain id, different endpoint', () => {
    const client = createGiwaFlashblocksClient()
    expect(client.chain.id).toBe(91_342)
    expect(client.transport['url']).toBe(GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL)
    expect(client.chain.experimental_preconfirmationTime).toBe(200)
  })

  test('createGiwaClients exposes both, clearly separated (KTD-5)', () => {
    const { chain, publicClient, flashblocksClient } = createGiwaClients()
    expect(chain.id).toBe(91_342)
    expect(publicClient.transport['url']).toBe(GIWA_SEPOLIA_RPC_URL)
    expect(flashblocksClient.transport['url']).toBe(
      GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL,
    )
  })

  test('preconfirmation reads use blockTag "pending"', () => {
    expect(PRECONFIRMATION_BLOCK_TAG).toBe('pending')
  })

  test('the wallet client carries the account and the standard RPC', () => {
    const account = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    )
    const client = createGiwaWalletClient({ account })
    expect(client.account.address).toBe(account.address)
    expect(client.chain.id).toBe(91_342)
    expect(client.transport['url']).toBe(GIWA_SEPOLIA_RPC_URL)
  })

  test('retry can be switched off entirely', () => {
    const client = createGiwaPublicClient({ retry: false })
    // Without the proxy, action identity is the raw viem function.
    expect(client.getBlockNumber).toBe(client.getBlockNumber)
    expect(client.chain.id).toBe(91_342)
  })

  test('a custom rpc url is respected (dedicated endpoint / local devnet)', () => {
    const client = createGiwaPublicClient({
      transport: { url: 'https://my-dedicated-rpc.example' },
    })
    expect(client.transport['url']).toBe('https://my-dedicated-rpc.example')
  })
})

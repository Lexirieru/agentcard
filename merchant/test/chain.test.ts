import { describe, expect, test } from 'bun:test'
import { privateKeyToAddress } from 'viem/accounts'
import { chainConfig } from 'viem/op-stack'

import {
  DEFAULT_RETRY_OPTIONS,
  GIWA_SEPOLIA_EXPLORER_API_URL,
  GIWA_SEPOLIA_EXPLORER_URL,
  GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL,
  GIWA_SEPOLIA_ID,
  GIWA_SEPOLIA_NETWORK,
  GIWA_SEPOLIA_RPC_URL,
  RpcRetryLimitError,
  createMerchantPublicClient,
  createMerchantWalletClient,
  giwaSepolia,
  giwaSepoliaExplorer,
  isTransientRpcError,
  retryAfterMs,
  withRetryingActions,
  withRpcRetry,
} from '../src/chain.js'

describe('giwaSepolia chain definition', () => {
  // These values must stay byte-identical to giwacard/src/chain/giwaSepolia.ts.
  // The merchant is a standalone service so the definition is copied, but a
  // drifted RPC url or chain id would silently point the facilitator at the
  // wrong chain.
  test('has chain id 91342 and the GIWA Sepolia name', () => {
    expect(giwaSepolia.id).toBe(91_342)
    expect(GIWA_SEPOLIA_ID).toBe(91_342)
    expect(giwaSepolia.name).toBe('GIWA Sepolia')
    expect(giwaSepolia.testnet).toBe(true)
  })

  test('uses the same RPC endpoints as the giwacard package', () => {
    expect(GIWA_SEPOLIA_RPC_URL).toBe('https://sepolia-rpc.giwa.io')
    expect(GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL).toBe(
      'https://sepolia-rpc-flashblocks.giwa.io',
    )
    expect(giwaSepolia.rpcUrls.default.http[0]).toBe(GIWA_SEPOLIA_RPC_URL)
    expect(giwaSepolia.rpcUrls['flashblocks']?.http[0]).toBe(
      GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL,
    )
  })

  test('uses the same explorer as the giwacard package', () => {
    expect(GIWA_SEPOLIA_EXPLORER_URL).toBe('https://sepolia-explorer.giwa.io')
    expect(GIWA_SEPOLIA_EXPLORER_API_URL).toBe(`${GIWA_SEPOLIA_EXPLORER_URL}/api`)
    expect(giwaSepolia.blockExplorers?.default.url).toBe(GIWA_SEPOLIA_EXPLORER_URL)
  })

  test('settles to Ethereum Sepolia and inherits the OP Stack chainConfig', () => {
    expect(giwaSepolia.sourceId).toBe(11_155_111)
    expect(giwaSepolia.formatters).toBe(chainConfig.formatters)
    expect(giwaSepolia.serializers).toBe(chainConfig.serializers)
  })

  test('names the network slug advertised in payment requirements', () => {
    expect(GIWA_SEPOLIA_NETWORK).toBe('giwa-sepolia')
  })

  test('builds explorer links', () => {
    expect(giwaSepoliaExplorer.tx('0xabc')).toBe(
      'https://sepolia-explorer.giwa.io/tx/0xabc',
    )
    expect(giwaSepoliaExplorer.address('0xdef')).toBe(
      'https://sepolia-explorer.giwa.io/address/0xdef',
    )
  })
})

describe('isTransientRpcError', () => {
  test('treats rate limiting and gateway failures as transient', () => {
    expect(isTransientRpcError({ status: 429 })).toBe(true)
    expect(isTransientRpcError({ status: 503 })).toBe(true)
    expect(isTransientRpcError({ code: -32005 })).toBe(true)
    expect(isTransientRpcError({ code: 'ECONNRESET' })).toBe(true)
    expect(isTransientRpcError(new Error('fetch failed'))).toBe(true)
  })

  test('treats a revert or a bad request as terminal', () => {
    expect(isTransientRpcError({ status: 400 })).toBe(false)
    expect(isTransientRpcError(new Error('execution reverted'))).toBe(false)
    expect(isTransientRpcError({ name: 'InvalidParamsRpcError' })).toBe(false)
  })

  test('treats a missing receipt as an answer, not a failure to retry', () => {
    expect(isTransientRpcError({ name: 'TransactionReceiptNotFoundError' })).toBe(false)
  })

  test('is safe on unknown shapes', () => {
    expect(isTransientRpcError(undefined)).toBe(false)
    expect(isTransientRpcError(null)).toBe(false)
    expect(isTransientRpcError({})).toBe(false)
  })
})

describe('withRpcRetry', () => {
  const noSleep = async () => {}

  test('returns on the first success', async () => {
    let attempts = 0
    const value = await withRpcRetry(
      async () => {
        attempts++
        return 'ok'
      },
      { sleep: noSleep },
    )
    expect(value).toBe('ok')
    expect(attempts).toBe(1)
  })

  test('retries a transient failure with exponential backoff', async () => {
    const delays: number[] = []
    let attempts = 0
    const value = await withRpcRetry(
      async () => {
        attempts++
        if (attempts < 3) throw Object.assign(new Error('rate limited'), { status: 429 })
        return attempts
      },
      { sleep: noSleep, jitter: false, onRetry: (info) => delays.push(info.delayMs) },
    )
    expect(value).toBe(3)
    expect(delays).toEqual([250, 500])
  })

  test('never retries a terminal failure', async () => {
    let attempts = 0
    await expect(
      withRpcRetry(
        async () => {
          attempts++
          throw new Error('execution reverted')
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow('execution reverted')
    expect(attempts).toBe(1)
  })

  test('gives up with RpcRetryLimitError after maxAttempts', async () => {
    let attempts = 0
    const failure = withRpcRetry(
      async () => {
        attempts++
        throw Object.assign(new Error('rate limited'), { status: 429 })
      },
      { sleep: noSleep, maxAttempts: 3 },
    )
    await expect(failure).rejects.toBeInstanceOf(RpcRetryLimitError)
    expect(attempts).toBe(3)
  })

  test('honours a Retry-After header', () => {
    expect(retryAfterMs({ headers: new Headers({ 'retry-after': '2' }) })).toBe(2_000)
    expect(retryAfterMs({ headers: { 'Retry-After': '1.5' } })).toBe(1_500)
    expect(retryAfterMs({})).toBeNull()
  })

  test('documents its defaults', () => {
    expect(DEFAULT_RETRY_OPTIONS.maxAttempts).toBe(4)
    expect(DEFAULT_RETRY_OPTIONS.baseDelayMs).toBe(250)
  })
})

describe('createMerchantPublicClient', () => {
  // No network calls: constructing a client does not talk to the RPC.
  test('targets GIWA Sepolia by default', () => {
    const client = createMerchantPublicClient({ retry: false })
    expect(client.chain.id).toBe(91_342)
  })

  test('accepts a transport override, for a dedicated or local RPC', () => {
    const client = createMerchantPublicClient({
      retry: false,
      transport: { url: 'http://127.0.0.1:8545' },
    })
    expect(client.transport.url).toBe('http://127.0.0.1:8545')
  })

  test('has no account: reads cannot spend, whatever else the service can do', () => {
    const client = createMerchantPublicClient({ retry: false })
    expect(client.account).toBeUndefined()
  })
})

describe('createMerchantWalletClient', () => {
  const KEY = '0x1111111111111111111111111111111111111111111111111111111111111111' as const

  test('binds the merchant account and targets GIWA Sepolia', () => {
    const client = createMerchantWalletClient({ retry: false, privateKey: KEY })
    expect(client.chain.id).toBe(91_342)
    expect(client.account.address).toBe(privateKeyToAddress(KEY))
  })

  test('accepts a transport override, for a dedicated or local RPC', () => {
    const client = createMerchantWalletClient({
      retry: false,
      privateKey: KEY,
      transport: { url: 'http://127.0.0.1:8545' },
    })
    expect(client.transport.url).toBe('http://127.0.0.1:8545')
  })

  test('never auto-retries a write, so one charge cannot become two', () => {
    // The retry wrapper is applied for parity with the read client, but
    // `writeContract` is on NON_RETRYABLE_ACTIONS: silently re-broadcasting a
    // settlement after a timeout is how a merchant pays gas twice for one sale.
    let attempts = 0
    const stub = {
      writeContract: () => {
        attempts++
        return Promise.reject(new Error('fetch failed'))
      },
    }
    const wrapped = withRetryingActions(stub, { maxAttempts: 4, sleep: async () => {} })
    return wrapped.writeContract().then(
      () => {
        throw new Error('expected the write to reject')
      },
      () => {
        expect(attempts).toBe(1)
      },
    )
  })
})

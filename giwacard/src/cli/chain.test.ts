import { describe, expect, test } from 'bun:test'
import type { Address, Hex } from 'viem'

import { RpcRetryLimitError } from '../chain/clients.js'
import {
  gasBudgetCells,
  preflightGas,
  readGasBudget,
  sendTx,
  toCliError,
  watchTx,
  withCliRetry,
  type CliPublicClient,
  type CliReceipt,
  type CliWalletClient,
  type RetryNotice,
  type TxPhaseEvent,
} from './chain.js'
import { CliError } from './errors.js'

/**
 * The interaction states this file covers are the ones the brief flagged as real
 * gaps: an RPC 429 producing a retry message rather than a crash, a gas
 * pre-check that fires before anything is signed, and a transaction watcher that
 * keeps "preconfirmed" and "safe" as different words (KTD-5).
 *
 * Nothing here touches a network. Every client is an object literal, which is
 * exactly what the structural interfaces in `./chain.ts` exist to permit.
 */

const VAULT = '0x1111111111111111111111111111111111111111' as Address
const ACCOUNT = '0x2222222222222222222222222222222222222222' as Address
const HASH = ('0x' + 'ab'.repeat(32)) as Hex
const FAUCET = 'https://faucet.example/'

const ABI = [
  {
    type: 'function',
    name: 'noop',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
] as const

/** A 429 shaped the way viem surfaces one. */
function rateLimited(): Error {
  const error = new Error('HTTP request failed.') as Error & {
    status: number
    headers: Headers
  }
  error.name = 'HttpRequestError'
  error.status = 429
  error.headers = new Headers({ 'retry-after': '1' })
  return error
}

function receipt(overrides: Partial<CliReceipt> = {}): CliReceipt {
  return {
    status: 'success',
    transactionHash: HASH,
    blockNumber: 100n,
    logs: [],
    ...overrides,
  }
}

interface FakeClientOptions {
  gas?: bigint
  gasPrice?: bigint
  balance?: bigint
  receipt?: CliReceipt
  safeBlock?: bigint | null
  onEstimate?: () => void
}

function fakePublicClient(options: FakeClientOptions = {}): CliPublicClient {
  return {
    readContract: async () => 0n,
    getBalance: async () => options.balance ?? 10n ** 18n,
    getGasPrice: async () => options.gasPrice ?? 1_000_000_000n,
    estimateContractGas: async () => {
      options.onEstimate?.()
      return options.gas ?? 21_000n
    },
    waitForTransactionReceipt: async () => options.receipt ?? receipt(),
    getBlock: async () => ({ number: options.safeBlock ?? 200n }),
  }
}

function fakeWallet(onWrite?: () => void): CliWalletClient {
  return {
    account: { address: ACCOUNT },
    writeContract: async () => {
      onWrite?.()
      return HASH
    },
    // `sendTx` never reaches for this — only the wizard's session-key top-up
    // does — but the interface requires it.
    sendTransaction: async () => HASH,
  }
}

const noSleep = async () => {}

/* -------------------------------------------------------------------------- */

describe('withCliRetry — a 429 retries with a message, it does not crash', () => {
  test('announces the retry and then succeeds', async () => {
    const notices: RetryNotice[] = []
    let attempts = 0

    const result = await withCliRetry(
      async () => {
        attempts++
        if (attempts < 3) throw rateLimited()
        return 'ok'
      },
      {
        onRetry: (notice) => notices.push(notice),
        sleep: noSleep,
        label: 'read the vault',
      },
    )

    expect(result).toBe('ok')
    expect(attempts).toBe(3)
    expect(notices).toHaveLength(2)
    expect(notices[0]?.message).toContain('rate-limiting')
    expect(notices[0]?.message).toContain('read the vault')
    expect(notices[0]?.message).toMatch(/attempt 2 of 3/)
  })

  test('a persistent 429 surfaces a CliError with a hint, never a raw error', async () => {
    const notices: RetryNotice[] = []
    const promise = withCliRetry(
      async () => {
        throw rateLimited()
      },
      { onRetry: (notice) => notices.push(notice), sleep: noSleep },
    )

    await expect(promise).rejects.toBeInstanceOf(CliError)
    // Two retries were announced before giving up: the user saw what happened.
    expect(notices).toHaveLength(2)

    const error = await promise.catch((caught: unknown) => caught as CliError)
    expect(error.code).toBe('RPC_UNAVAILABLE')
    expect(error.retryable).toBe(true)
    expect(error.hint).toContain('GIWACARD_RPC_URL')
    expect(error.message).toContain('429')
    expect(error.message).not.toContain('at ')
  })

  test('a terminal failure is not retried', async () => {
    let attempts = 0
    const promise = withCliRetry(
      async () => {
        attempts++
        const error = new Error('execution reverted: nope')
        throw error
      },
      { sleep: noSleep },
    )
    await expect(promise).rejects.toBeInstanceOf(CliError)
    expect(attempts).toBe(1)
  })

  test('the retry-limit error from the shared wrapper maps to RPC_UNAVAILABLE', () => {
    const error = toCliError(
      new RpcRetryLimitError('gave up', { attempts: 4 }),
    )
    expect(error.code).toBe('RPC_UNAVAILABLE')
  })
})

/* -------------------------------------------------------------------------- */

describe('preflightGas — the user learns they are short before signing', () => {
  test('passes when the balance covers the estimate plus headroom', async () => {
    const estimate = await preflightGas({
      publicClient: fakePublicClient({ gas: 100_000n, gasPrice: 1_000_000_000n, balance: 10n ** 18n }),
      account: ACCOUNT,
      role: 'owner wallet',
      address: VAULT,
      abi: ABI,
      functionName: 'noop',
      faucetUrl: FAUCET,
    })
    expect(estimate.sufficient).toBe(true)
    // 100k gas * 1 gwei = 1e14, plus 25% headroom.
    expect(estimate.costWei).toBe(125_000_000_000_000n)
  })

  test('refuses with INSUFFICIENT_GAS naming the role, the shortfall and the faucet', async () => {
    const promise = preflightGas({
      publicClient: fakePublicClient({
        gas: 100_000n,
        gasPrice: 1_000_000_000n,
        balance: 1n,
      }),
      account: ACCOUNT,
      role: 'session key',
      address: VAULT,
      abi: ABI,
      functionName: 'noop',
      faucetUrl: FAUCET,
    })

    const error = (await promise.catch((caught: unknown) => caught)) as CliError
    expect(error).toBeInstanceOf(CliError)
    expect(error.code).toBe('INSUFFICIENT_GAS')
    expect(error.message).toContain('session key')
    expect(error.message).toContain(ACCOUNT)
    expect(error.message).toContain('short')
    expect(error.message).toContain('Nothing was signed or sent')
    expect(error.hint).toContain(FAUCET)
  })

  test('sendTx never reaches writeContract when gas is short', async () => {
    let wrote = false
    const promise = sendTx({
      publicClient: fakePublicClient({ gas: 100_000n, balance: 0n }),
      wallet: fakeWallet(() => {
        wrote = true
      }),
      role: 'owner wallet',
      address: VAULT,
      abi: ABI,
      functionName: 'noop',
      faucetUrl: FAUCET,
    })

    await expect(promise).rejects.toBeInstanceOf(CliError)
    expect(wrote).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */

describe('readGasBudget — the per-submitter table (KTD-6)', () => {
  test('flags an underfunded submitter', async () => {
    const rows = await readGasBudget(fakePublicClient({ balance: 5n }), [
      { role: 'owner wallet', address: ACCOUNT, targetWei: 1_000n },
      { role: 'session key', address: VAULT, targetWei: 1n },
    ])
    expect(rows[0]?.funded).toBe(false)
    expect(rows[1]?.funded).toBe(true)
    expect(gasBudgetCells(rows[0] as never)).toContain('TOP UP')
    expect(gasBudgetCells(rows[1] as never)).toContain('ok')
  })
})

/* -------------------------------------------------------------------------- */

describe('watchTx — preconfirmed is not the same as safe (KTD-5)', () => {
  test('reports submitted, preconfirmed, included and safe as distinct phases', async () => {
    const phases: TxPhaseEvent[] = []
    const outcome = await watchTx(HASH, {
      publicClient: fakePublicClient({ safeBlock: 200n }),
      preconfClient: { getTransactionReceipt: async () => receipt({ blockNumber: 99n }) },
      onPhase: (event) => phases.push(event),
      sleep: noSleep,
    })

    expect(phases.map((phase) => phase.phase)).toEqual([
      'submitted',
      'preconfirmed',
      'included',
      'safe',
    ])
    expect(outcome.safe).toBe(true)

    const preconfirmed = phases.find((phase) => phase.phase === 'preconfirmed')
    expect(preconfirmed?.final).toBe(false)
    // The word "final" has to appear as a negation, in the message a user reads.
    expect(preconfirmed?.message).toContain('NOT final')
    expect(preconfirmed?.message).toContain('Flashblocks')

    const safe = phases.find((phase) => phase.phase === 'safe')
    expect(safe?.final).toBe(true)
    expect(safe?.message).toContain('final')
  })

  test('skips the preconfirmed phase when no Flashblocks client is supplied', async () => {
    const phases: TxPhaseEvent[] = []
    await watchTx(HASH, {
      publicClient: fakePublicClient({ safeBlock: 200n }),
      onPhase: (event) => phases.push(event),
      sleep: noSleep,
    })
    expect(phases.map((phase) => phase.phase)).toEqual([
      'submitted',
      'included',
      'safe',
    ])
  })

  test('a Flashblocks failure does not fail the transaction', async () => {
    const outcome = await watchTx(HASH, {
      publicClient: fakePublicClient({ safeBlock: 200n }),
      preconfClient: {
        getTransactionReceipt: async () => {
          throw new Error('flashblocks is down')
        },
      },
      sleep: noSleep,
    })
    expect(outcome.safe).toBe(true)
  })

  test('reports not-safe rather than hanging when the safe block lags', async () => {
    let clock = 0
    const outcome = await watchTx(HASH, {
      publicClient: fakePublicClient({ safeBlock: 1n }),
      sleep: async () => {
        clock += 1_000
      },
      now: () => clock,
      safeTimeoutMs: 3_000,
    })
    expect(outcome.safe).toBe(false)
    expect(outcome.receipt.blockNumber).toBe(100n)
  })

  test('a mined-but-reverted transaction is a typed error, not a silent success', async () => {
    const promise = watchTx(HASH, {
      publicClient: fakePublicClient({ receipt: receipt({ status: 'reverted' }) }),
      sleep: noSleep,
    })
    const error = (await promise.catch((caught: unknown) => caught)) as CliError
    expect(error).toBeInstanceOf(CliError)
    expect(error.code).toBe('TRANSACTION_REVERTED')
    expect(error.message).toContain('Nothing changed onchain')
    expect(error.hint).toContain('sepolia-explorer.giwa.io')
  })

  test('waitForSafe:false stops at included and says so', async () => {
    const phases: TxPhaseEvent[] = []
    const outcome = await watchTx(HASH, {
      publicClient: fakePublicClient(),
      onPhase: (event) => phases.push(event),
      waitForSafe: false,
      sleep: noSleep,
    })
    expect(outcome.safe).toBe(false)
    expect(phases.at(-1)?.phase).toBe('included')
    expect(phases.at(-1)?.message).toContain('Not yet safe')
  })
})

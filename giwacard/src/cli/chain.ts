import type { Abi, Address, Hex } from 'viem'

import { isTransientRpcError, RpcRetryLimitError } from '../chain/clients.js'
import { giwaSepoliaExplorer } from '../chain/giwaSepolia.js'
import {
  CliError,
  formatEth,
  insufficientGasError,
  rpcUnavailableError,
  unexpectedError,
} from './errors.js'

/**
 * The chain operations the CLI performs, over the narrowest client interfaces
 * that can perform them.
 *
 * The structural-interface trick is borrowed from `src/mcp/context.ts` and for
 * the same reason: a test supplies an object literal with four methods instead
 * of standing up viem against a live endpoint, which is what makes "mock the
 * chain, never hit a real RPC" cheap enough to do in every test. A real
 * `GiwaPublicClient` satisfies {@link CliPublicClient} structurally.
 *
 * Two behaviours in this module are requirements rather than conveniences:
 *
 * - **Gas is checked before every transaction** ({@link preflightGas}). The user
 *   must learn they are short *before* anything is signed, not from a node's
 *   idiosyncratic "insufficient funds" prose afterwards.
 * - **A transaction is watched through two distinct states** ({@link watchTx}).
 *   KTD-5: a Flashblocks preconfirmation is *not* final. The watcher reports
 *   `preconfirmed` and `safe` as different things and labels the first one
 *   plainly as not-yet-final, because a UI that conflates them teaches users to
 *   trust a state that can still be reorged away.
 */

/* -------------------------------------------------------------------------- */
/* Client interfaces                                                          */
/* -------------------------------------------------------------------------- */

/** A block header, reduced to the field the safe-block check reads. */
export interface CliBlock {
  number: bigint | null
}

/** A receipt, reduced to what the CLI reports. */
export interface CliReceipt {
  status: 'success' | 'reverted'
  transactionHash: Hex
  blockNumber: bigint
  logs: readonly unknown[]
}

/** Read side of the chain. */
export interface CliPublicClient {
  readContract(args: {
    address: Address
    abi: Abi | readonly unknown[]
    functionName: string
    args?: readonly unknown[]
  }): Promise<unknown>
  getBalance(args: { address: Address }): Promise<bigint>
  getGasPrice(): Promise<bigint>
  estimateContractGas(args: {
    address: Address
    abi: Abi | readonly unknown[]
    functionName: string
    args?: readonly unknown[]
    account: Address
  }): Promise<bigint>
  waitForTransactionReceipt(args: { hash: Hex }): Promise<CliReceipt>
  getBlock(args: { blockTag: 'safe' | 'latest' | 'finalized' }): Promise<CliBlock>
}

/** Write side of the chain: one owner or session wallet. */
export interface CliWalletClient {
  account: { address: Address }
  writeContract(args: {
    address: Address
    abi: Abi | readonly unknown[]
    functionName: string
    args?: readonly unknown[]
  }): Promise<Hex>
  /**
   * Plain value transfer, with no contract behind it.
   *
   * Used by exactly one caller: the wizard topping the session key up out of
   * the owner wallet. Every other write in this CLI goes through
   * {@link sendTx}, which needs an ABI and a function name.
   */
  sendTransaction(args: { to: Address; value: bigint }): Promise<Hex>
}

/**
 * A Flashblocks read client (KTD-5).
 *
 * Optional everywhere. When absent the watcher simply skips the `preconfirmed`
 * phase and goes straight from `submitted` to `included` — a slower but never
 * *wrong* experience, which is the right way round for an optional optimisation.
 */
export interface CliPreconfClient {
  getTransactionReceipt(args: { hash: Hex }): Promise<CliReceipt | null>
}

/* -------------------------------------------------------------------------- */
/* Failure classification                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Turn anything thrown by a chain call into a {@link CliError}.
 *
 * The rate-limit branch is the load-bearing one: both public GIWA endpoints are
 * documented as throttled, so 429 and socket timeouts are the *expected* failure
 * of a demo, not an exotic one. They must produce a sentence and a retry path,
 * never a stack.
 */
export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error
  if (error instanceof RpcRetryLimitError) return rpcUnavailableError(error)
  if (isTransientRpcError(error)) return rpcUnavailableError(error)

  const revert = revertNameOf(error)
  if (revert !== null) {
    return new CliError(
      'TRANSACTION_REVERTED',
      `The transaction was rejected by the vault: ${revert}.`,
      {
        hint: 'Run `giwacard status` to re-read the vault before trying again.',
        cause: error,
      },
    )
  }

  return unexpectedError(error)
}

/** Pull viem's decoded custom-error name out of an error chain, if there is one. */
function revertNameOf(error: unknown): string | null {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current; depth++) {
    const candidate = current as {
      name?: unknown
      data?: { errorName?: unknown }
      reason?: unknown
      cause?: unknown
    }
    if (typeof candidate.data?.errorName === 'string') return candidate.data.errorName
    if (
      candidate.name === 'ContractFunctionRevertedError' &&
      typeof candidate.reason === 'string'
    ) {
      return candidate.reason
    }
    current = candidate.cause
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Retry path                                                                 */
/* -------------------------------------------------------------------------- */

/** What a caller is told between attempts. */
export interface RetryNotice {
  attempt: number
  maxAttempts: number
  delayMs: number
  message: string
}

export interface CliRetryOptions {
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number
  /** Delay before attempt 2; doubles each time. Default 800ms. */
  baseDelayMs?: number
  /** Called before each retry, with a message written for a person. */
  onRetry?: (notice: RetryNotice) => void
  /** Injected so the suite never actually waits. */
  sleep?: (ms: number) => Promise<void>
  /** What the operation is called in the retry message, e.g. `read the vault`. */
  label?: string
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Run a chain call, retrying transient failures with a message the user can see.
 *
 * This is the "429 produces a retry message rather than a crash" requirement in
 * code: a rate-limited endpoint is announced (`onRetry`), retried, and only if
 * it keeps failing does it surface — still as a {@link CliError} with a hint,
 * never as a stack.
 *
 * @param operation The chain call. Receives the 1-based attempt number.
 * @throws {CliError} Always a classified error, never a raw viem failure.
 */
export async function withCliRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: CliRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3
  const baseDelayMs = options.baseDelayMs ?? 800
  const sleep = options.sleep ?? defaultSleep
  const label = options.label ?? 'the request'

  let last: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation(attempt)
    } catch (error) {
      last = error
      const transient =
        error instanceof RpcRetryLimitError || isTransientRpcError(error)
      if (!transient || attempt === maxAttempts) break
      const delayMs = baseDelayMs * 2 ** (attempt - 1)
      options.onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        message:
          `The GIWA Sepolia RPC is rate-limiting or timing out while trying to ` +
          `${label}. Retrying in ${Math.round(delayMs / 1000) || 1}s ` +
          `(attempt ${attempt + 1} of ${maxAttempts}).`,
      })
      await sleep(delayMs)
    }
  }
  throw toCliError(last)
}

/* -------------------------------------------------------------------------- */
/* Gas pre-check (KTD-6)                                                      */
/* -------------------------------------------------------------------------- */

/** One row of the wizard's per-submitter gas budget table (KTD-6). */
export interface GasBudgetRow {
  /** What this address does, e.g. `owner wallet`, `session key`. */
  role: string
  address: Address
  balanceWei: bigint
  /** What the role is expected to need across the demo. */
  targetWei: bigint
  /** True when `balanceWei >= targetWei`. */
  funded: boolean
}

/** A gas estimate for one specific transaction. */
export interface GasEstimate {
  gas: bigint
  gasPriceWei: bigint
  /** `gas * gasPrice`, with the headroom multiplier already applied. */
  costWei: bigint
  balanceWei: bigint
  sufficient: boolean
}

/**
 * Headroom on the estimate.
 *
 * A pre-check that passes at exactly the estimate is a pre-check that fails at
 * submit time whenever the basefee ticks up between the two calls — which on an
 * OP Stack L2 with L1 data costs is routine. 25% is enough to absorb that
 * without refusing a user who genuinely can afford the transaction.
 */
export const GAS_HEADROOM_NUMERATOR = 125n
export const GAS_HEADROOM_DENOMINATOR = 100n

export interface PreflightGasInput {
  publicClient: CliPublicClient
  /** The address that will submit — the "named submitter" of KTD-6. */
  account: Address
  /** Human name for that address, used in the failure message. */
  role: string
  address: Address
  abi: Abi | readonly unknown[]
  functionName: string
  args?: readonly unknown[]
  faucetUrl: string
}

/**
 * Estimate what a transaction will cost and refuse it if the submitter is short.
 *
 * Called before *every* write the CLI performs. The point is the ordering: the
 * user is told they are short before a signature is produced, so "not enough
 * gas" is never something they discover from a failed broadcast.
 *
 * @throws {CliError} `INSUFFICIENT_GAS` when the balance cannot cover the
 * estimate plus headroom. `RPC_UNAVAILABLE` when the estimate itself fails.
 */
export async function preflightGas(
  input: PreflightGasInput,
): Promise<GasEstimate> {
  const estimate = await withCliRetry(
    async () => {
      const [gas, gasPriceWei, balanceWei] = await Promise.all([
        input.publicClient.estimateContractGas({
          address: input.address,
          abi: input.abi,
          functionName: input.functionName,
          ...(input.args !== undefined ? { args: input.args } : {}),
          account: input.account,
        }),
        input.publicClient.getGasPrice(),
        input.publicClient.getBalance({ address: input.account }),
      ])
      const costWei =
        (gas * gasPriceWei * GAS_HEADROOM_NUMERATOR) / GAS_HEADROOM_DENOMINATOR
      return {
        gas,
        gasPriceWei,
        costWei,
        balanceWei,
        sufficient: balanceWei >= costWei,
      } satisfies GasEstimate
    },
    { label: `estimate gas for ${input.functionName}` },
  )

  if (!estimate.sufficient) {
    throw insufficientGasError({
      address: input.account,
      role: input.role,
      balanceWei: estimate.balanceWei,
      requiredWei: estimate.costWei,
      faucetUrl: input.faucetUrl,
    })
  }
  return estimate
}

/**
 * Build the per-submitter gas budget table (KTD-6).
 *
 * Every transaction in giwacard has a named submitter — in-policy mints and
 * charges go out from the session key, approval mints and every owner action
 * from the owner wallet — and the wizard shows the user both rows rather than a
 * single opaque "you need ETH".
 */
export async function readGasBudget(
  publicClient: CliPublicClient,
  submitters: readonly { role: string; address: Address; targetWei: bigint }[],
): Promise<GasBudgetRow[]> {
  return withCliRetry(
    async () =>
      Promise.all(
        submitters.map(async (submitter) => {
          const balanceWei = await publicClient.getBalance({
            address: submitter.address,
          })
          return {
            role: submitter.role,
            address: submitter.address,
            balanceWei,
            targetWei: submitter.targetWei,
            funded: balanceWei >= submitter.targetWei,
          } satisfies GasBudgetRow
        }),
      ),
    { label: 'read gas balances' },
  )
}

/** Render a budget row the way the wizard's table shows it. */
export function gasBudgetCells(row: GasBudgetRow): string[] {
  return [
    row.role,
    row.address,
    `${formatEth(row.balanceWei)} ETH`,
    `${formatEth(row.targetWei)} ETH`,
    row.funded ? 'ok' : 'TOP UP',
  ]
}

/* -------------------------------------------------------------------------- */
/* Transaction watcher (KTD-5)                                                */
/* -------------------------------------------------------------------------- */

/**
 * The states a transaction passes through, in order.
 *
 * `preconfirmed` and `safe` are separate members on purpose. A Flashblocks
 * preconfirmation arrives in ~200ms and is what makes the CLI feel instant, but
 * it is a sequencer promise, not consensus — the sequencer can still reorg it
 * away. Only `safe` means the state is settled. Collapsing the two would be a
 * correctness bug dressed as a UX simplification.
 */
export type TxPhase = 'submitted' | 'preconfirmed' | 'included' | 'safe'

/** A phase transition, with text already written for a person. */
export interface TxPhaseEvent {
  phase: TxPhase
  hash: Hex
  /** True only for `safe`. Everything before it can still change. */
  final: boolean
  message: string
  blockNumber?: bigint
}

export interface WatchTxOptions {
  publicClient: CliPublicClient
  /** Flashblocks client. Omit to skip the `preconfirmed` phase. */
  preconfClient?: CliPreconfClient | undefined
  onPhase?: (event: TxPhaseEvent) => void
  /**
   * Wait for the safe block after inclusion. Default true.
   *
   * Set false for a transaction whose outcome the user is not about to act on —
   * the phase text still says, in words, that the state is not final.
   */
  waitForSafe?: boolean
  /** How long to keep polling for the safe block before giving up. */
  safeTimeoutMs?: number
  pollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** The outcome of watching one transaction. */
export interface TxOutcome {
  hash: Hex
  receipt: CliReceipt
  /** False when the safe wait timed out — the transaction is included, not settled. */
  safe: boolean
  explorerUrl: string
}

const PRECONFIRMED_NOTE =
  'preconfirmed by the sequencer (Flashblocks) — this is NOT final and can ' +
  'still be reorged'

/**
 * Watch a submitted transaction from broadcast to a safe block.
 *
 * @param hash The transaction hash.
 * @throws {CliError} `TRANSACTION_REVERTED` when it is mined but reverted,
 * `RPC_UNAVAILABLE` when the RPC gives up.
 */
export async function watchTx(
  hash: Hex,
  options: WatchTxOptions,
): Promise<TxOutcome> {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? (() => Date.now())
  const pollIntervalMs = options.pollIntervalMs ?? 500
  const explorerUrl = giwaSepoliaExplorer.tx(hash)

  const emit = (event: TxPhaseEvent) => options.onPhase?.(event)

  emit({
    phase: 'submitted',
    hash,
    final: false,
    message: `Submitted ${hash}. Waiting for the sequencer.`,
  })

  // A preconfirmation is best-effort by construction: a failure to read one says
  // nothing about the transaction, so it is swallowed rather than surfaced.
  if (options.preconfClient) {
    try {
      const preconf = await options.preconfClient.getTransactionReceipt({ hash })
      if (preconf) {
        emit({
          phase: 'preconfirmed',
          hash,
          final: false,
          blockNumber: preconf.blockNumber,
          message: `Card transaction ${PRECONFIRMED_NOTE}.`,
        })
      }
    } catch {
      // Ignored on purpose. See above.
    }
  }

  const receipt = await withCliRetry(
    () => options.publicClient.waitForTransactionReceipt({ hash }),
    { label: 'wait for the transaction receipt' },
  )

  if (receipt.status !== 'success') {
    throw new CliError(
      'TRANSACTION_REVERTED',
      `Transaction ${hash} was mined but reverted. Nothing changed onchain.`,
      {
        hint: `Inspect it at ${explorerUrl}, then run \`giwacard status\` before retrying.`,
      },
    )
  }

  emit({
    phase: 'included',
    hash,
    final: false,
    blockNumber: receipt.blockNumber,
    message:
      `Included in block ${receipt.blockNumber}. Not yet safe — waiting for the ` +
      'safe block.',
  })

  if (options.waitForSafe === false) {
    return { hash, receipt, safe: false, explorerUrl }
  }

  const deadline = now() + (options.safeTimeoutMs ?? 60_000)
  for (;;) {
    let safeBlock: CliBlock
    try {
      safeBlock = await options.publicClient.getBlock({ blockTag: 'safe' })
    } catch (error) {
      // The safe wait is an upgrade on top of a confirmed receipt. An RPC that
      // will not answer `blockTag: 'safe'` must not turn a successful
      // transaction into a reported failure.
      if (!isTransientRpcError(error)) throw toCliError(error)
      safeBlock = { number: null }
    }

    if (safeBlock.number !== null && safeBlock.number >= receipt.blockNumber) {
      emit({
        phase: 'safe',
        hash,
        final: true,
        blockNumber: receipt.blockNumber,
        message: `Safe at block ${receipt.blockNumber}. This is final.`,
      })
      return { hash, receipt, safe: true, explorerUrl }
    }

    if (now() >= deadline) {
      return { hash, receipt, safe: false, explorerUrl }
    }
    await sleep(pollIntervalMs)
  }
}

/* -------------------------------------------------------------------------- */
/* Submit + watch                                                             */
/* -------------------------------------------------------------------------- */

export interface SendTxInput extends Omit<PreflightGasInput, 'account'> {
  wallet: CliWalletClient
  preconfClient?: CliPreconfClient | undefined
  onPhase?: (event: TxPhaseEvent) => void
  waitForSafe?: boolean
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  safeTimeoutMs?: number
  pollIntervalMs?: number
}

/**
 * Pre-check gas, submit, and watch a contract write to a safe block.
 *
 * The one entry point every CLI write uses, so the gas pre-check cannot be
 * skipped by a command that forgets it, and every write reports the same
 * preconfirmed-vs-safe distinction.
 *
 * Note what is *not* retried: the `writeContract` itself. A retried submit can
 * broadcast the same intent twice, which for a mint means two cards. Only the
 * estimate and the wait are retried.
 */
export async function sendTx(input: SendTxInput): Promise<TxOutcome> {
  await preflightGas({
    publicClient: input.publicClient,
    account: input.wallet.account.address,
    role: input.role,
    address: input.address,
    abi: input.abi,
    functionName: input.functionName,
    ...(input.args !== undefined ? { args: input.args } : {}),
    faucetUrl: input.faucetUrl,
  })

  let hash: Hex
  try {
    hash = await input.wallet.writeContract({
      address: input.address,
      abi: input.abi,
      functionName: input.functionName,
      ...(input.args !== undefined ? { args: input.args } : {}),
    })
  } catch (error) {
    throw toCliError(error)
  }

  return watchTx(hash, {
    publicClient: input.publicClient,
    ...(input.preconfClient !== undefined
      ? { preconfClient: input.preconfClient }
      : {}),
    ...(input.onPhase !== undefined ? { onPhase: input.onPhase } : {}),
    ...(input.waitForSafe !== undefined ? { waitForSafe: input.waitForSafe } : {}),
    ...(input.sleep !== undefined ? { sleep: input.sleep } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.safeTimeoutMs !== undefined
      ? { safeTimeoutMs: input.safeTimeoutMs }
      : {}),
    ...(input.pollIntervalMs !== undefined
      ? { pollIntervalMs: input.pollIntervalMs }
      : {}),
  })
}

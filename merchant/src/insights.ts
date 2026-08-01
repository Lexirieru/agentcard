/**
 * "GIWA Insights" — the product this merchant sells for 1 gUSD.
 *
 * An on-demand analytics report about GIWA Sepolia itself: how fast the
 * sequencer is producing blocks, how full those blocks are, what the base fee is
 * doing, and what kind of traffic is on the chain right now. Everything is
 * computed from live `eth_getBlockNumber` / `eth_getBlockByNumber` /
 * `eth_gasPrice` reads against the chain's own RPC — there is no third-party
 * analytics API behind it and no API key to configure. That is deliberate: a
 * demo that needs someone else's key is a demo that stops working.
 *
 * The reads are injected through {@link InsightsReader} so the test suite never
 * hits a live RPC.
 */

import { formatGwei, type Address, type Hash } from 'viem'

/* -------------------------------------------------------------------------- */
/* Reader interface                                                           */
/* -------------------------------------------------------------------------- */

/** A transaction, narrowed to the fields the report reads. */
export interface InsightsTransaction {
  readonly hash: Hash
  readonly from: Address
  /** `null` for a contract creation. */
  readonly to: Address | null
  /**
   * Transaction type as viem's OP Stack formatter names it: `legacy`,
   * `eip1559`, `eip2930`, `eip4844`, `eip7702` or `deposit` (the `0x7e`
   * L1→L2 deposit transactions that are unique to OP Stack chains).
   */
  readonly type: string
  readonly gas: bigint
  readonly value: bigint
}

/** A block, narrowed to the fields the report reads. */
export interface InsightsBlock {
  readonly number: bigint
  readonly hash: Hash
  /** Unix seconds. */
  readonly timestamp: bigint
  readonly gasUsed: bigint
  readonly gasLimit: bigint
  /** `null` on a pre-EIP-1559 chain; GIWA always sets it. */
  readonly baseFeePerGas: bigint | null
  readonly transactions: readonly InsightsTransaction[]
}

/**
 * The only chain access report generation needs.
 *
 * Injected so tests are deterministic and offline.
 */
export interface InsightsReader {
  /** Head of the sequencer chain. */
  getBlockNumber(): Promise<bigint>
  /** A full block, transactions included. */
  getBlock(blockNumber: bigint): Promise<InsightsBlock>
  /** Current suggested gas price, in wei. */
  getGasPrice(): Promise<bigint>
}

/** The subset of a viem public client {@link createViemInsightsReader} needs. */
export interface ViemInsightsClient {
  getBlockNumber(): Promise<bigint>
  getGasPrice(): Promise<bigint>
  getBlock(args: { blockNumber: bigint; includeTransactions: true }): Promise<{
    number: bigint | null
    hash: Hash | null
    timestamp: bigint
    gasUsed: bigint
    gasLimit: bigint
    baseFeePerGas: bigint | null
    transactions: readonly {
      hash: Hash
      from: Address
      to: Address | null
      type: string
      gas: bigint
      value: bigint
    }[]
  }>
}

/** Thrown when the chain answers with something a report cannot be built from. */
export class InsightsDataError extends Error {
  override readonly name = 'InsightsDataError'
}

/**
 * Adapt a viem public client to {@link InsightsReader}.
 *
 * Pending blocks have `number === null` and `hash === null`; we only ever ask
 * for concrete block numbers, so that case is an RPC contract violation rather
 * than something to paper over.
 */
export function createViemInsightsReader(client: ViemInsightsClient): InsightsReader {
  return {
    getBlockNumber: () => client.getBlockNumber(),
    getGasPrice: () => client.getGasPrice(),
    async getBlock(blockNumber) {
      const block = await client.getBlock({ blockNumber, includeTransactions: true })
      if (block.number === null || block.hash === null) {
        throw new InsightsDataError(
          `RPC returned a pending block for the concrete block number ${blockNumber}.`,
        )
      }
      return {
        number: block.number,
        hash: block.hash,
        timestamp: block.timestamp,
        gasUsed: block.gasUsed,
        gasLimit: block.gasLimit,
        baseFeePerGas: block.baseFeePerGas,
        transactions: block.transactions.map((tx) => ({
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          type: tx.type,
          gas: tx.gas,
          value: tx.value,
        })),
      }
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Report shape                                                               */
/* -------------------------------------------------------------------------- */

/** Which blocks the report covers. */
export interface InsightsWindow {
  readonly fromBlock: string
  readonly toBlock: string
  /** Number of blocks actually sampled. */
  readonly blocks: number
  /** Unix seconds of the oldest sampled block. */
  readonly fromTimestamp: number
  /** Unix seconds of the newest sampled block. */
  readonly toTimestamp: number
  /** Wall-clock span the window covers, in seconds. */
  readonly spanSeconds: number
}

/** How steadily the sequencer is producing blocks. */
export interface InsightsCadence {
  readonly meanBlockSeconds: number
  readonly medianBlockSeconds: number
  readonly minBlockSeconds: number
  readonly maxBlockSeconds: number
  /** Population standard deviation of the block interval, in seconds. */
  readonly jitterSeconds: number
  readonly blocksPerMinute: number
}

/** How much of the available block space is being used. */
export interface InsightsGas {
  readonly totalGasUsed: string
  readonly meanGasUsedPerBlock: string
  readonly peakGasUsed: string
  readonly gasLimit: string
  /** Mean `gasUsed / gasLimit`, as a percentage. */
  readonly meanUtilisationPct: number
  readonly peakUtilisationPct: number
}

/** What it costs to transact right now. */
export interface InsightsFees {
  readonly latestBaseFeeWei: string | null
  readonly latestBaseFeeGwei: string | null
  readonly meanBaseFeeWei: string | null
  readonly minBaseFeeWei: string | null
  readonly maxBaseFeeWei: string | null
  readonly suggestedGasPriceWei: string
  readonly suggestedGasPriceGwei: string
}

/** Who and what is transacting. */
export interface InsightsActivity {
  readonly totalTransactions: number
  readonly meanTransactionsPerBlock: number
  readonly peakTransactionsInBlock: number
  readonly emptyBlocks: number
  readonly transactionsPerSecond: number
  readonly uniqueSenders: number
  readonly uniqueRecipients: number
  readonly contractCreations: number
  /** Count per viem transaction-type name, e.g. `{ eip1559: 42, deposit: 3 }`. */
  readonly transactionTypes: Readonly<Record<string, number>>
  /** OP Stack L1→L2 deposit transactions in the window. */
  readonly depositTransactions: number
  /** The block with the most transactions in the window. */
  readonly busiestBlock: { readonly number: string; readonly transactions: number }
}

/** The full paid product. */
export interface GiwaInsightsReport {
  readonly product: 'GIWA Insights'
  readonly reportVersion: 1
  readonly generatedAt: string
  readonly chain: {
    readonly id: number
    readonly name: string
    readonly network: string
  }
  readonly window: InsightsWindow
  readonly cadence: InsightsCadence
  readonly gas: InsightsGas
  readonly fees: InsightsFees
  readonly activity: InsightsActivity
  /** Plain-language findings, ready to paste into an answer. */
  readonly highlights: readonly string[]
  /** Provenance and caveats, including the KTD-5 release policy. */
  readonly notes: readonly string[]
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Round to `digits` decimal places, avoiding `-0` and `NaN` leaking out. */
function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  const rounded = Math.round(value * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  let total = 0
  for (const value of values) total += value
  return total / values.length
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

function standardDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0
  const average = mean(values)
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)))
}

/** Thousands-separated integer, for the human-readable highlights. */
function group(value: bigint | number): string {
  return value.toLocaleString('en-US')
}

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * The public GIWA RPC is rate-limited, so a report that fired 30 block reads at
 * once would spend most of its life being told 429.
 */
export async function mapWithConcurrency<item, result>(
  items: readonly item[],
  limit: number,
  fn: (item: item, index: number) => Promise<result>,
): Promise<result[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError(`mapWithConcurrency: limit must be a positive integer, got ${String(limit)}`)
  }
  const results = new Array<result>(items.length)
  let cursor = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) return
      results[index] = await fn(item, index)
    }
  })

  await Promise.all(workers)
  return results
}

/* -------------------------------------------------------------------------- */
/* Report generation                                                          */
/* -------------------------------------------------------------------------- */

/** Knobs for {@link generateInsightsReport}. */
export interface GenerateInsightsOptions {
  /** How many recent blocks to sample. Default 30, minimum 2. */
  readonly blockCount?: number
  /** Concurrent block reads. Default 6. */
  readonly concurrency?: number
  /** Chain metadata echoed into the report. */
  readonly chain?: { id: number; name: string; network: string }
  /** Injected clock, so tests are deterministic. */
  readonly now?: () => Date
}

const DEFAULT_CHAIN = {
  id: 91_342,
  name: 'GIWA Sepolia',
  network: 'giwa-sepolia',
} as const

/**
 * Build a GIWA Insights report from live chain reads.
 *
 * Samples the most recent `blockCount` blocks (clamped to what the chain
 * actually has), then derives cadence, gas, fee and activity statistics from
 * them. Every number in the report is computed here; nothing is fetched from a
 * third party.
 *
 * @throws {InsightsDataError} when the chain is too short to sample, or returns
 * a block that cannot be used.
 */
export async function generateInsightsReport(
  reader: InsightsReader,
  options: GenerateInsightsOptions = {},
): Promise<GiwaInsightsReport> {
  const requested = options.blockCount ?? 30
  if (!Number.isInteger(requested) || requested < 2) {
    throw new TypeError(
      `generateInsightsReport: blockCount must be an integer >= 2, got ${String(requested)}`,
    )
  }
  const concurrency = options.concurrency ?? 6
  const now = options.now ?? (() => new Date())
  const chain = options.chain ?? DEFAULT_CHAIN

  const [head, suggestedGasPrice] = await Promise.all([
    reader.getBlockNumber(),
    reader.getGasPrice(),
  ])

  // Block 0 exists, so a head of N gives N+1 blocks to choose from.
  const available = head + 1n
  const sampleSize = Number(available < BigInt(requested) ? available : BigInt(requested))
  if (sampleSize < 2) {
    throw new InsightsDataError(
      `GIWA Sepolia has only ${available} block(s); at least 2 are needed to measure cadence.`,
    )
  }

  const numbers = Array.from(
    { length: sampleSize },
    (_, offset) => head - BigInt(sampleSize - 1 - offset),
  )
  const blocks = await mapWithConcurrency(numbers, concurrency, (blockNumber) =>
    reader.getBlock(blockNumber),
  )

  // Defensive: an RPC that returns blocks out of order would silently invert
  // every interval below.
  blocks.sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0))

  const oldest = blocks[0]
  const newest = blocks[blocks.length - 1]
  if (oldest === undefined || newest === undefined) {
    throw new InsightsDataError('The RPC returned no blocks for the requested window.')
  }

  /* -- cadence ------------------------------------------------------------ */

  const intervals: number[] = []
  for (let index = 1; index < blocks.length; index++) {
    const previous = blocks[index - 1]
    const current = blocks[index]
    if (previous === undefined || current === undefined) continue
    intervals.push(Number(current.timestamp - previous.timestamp))
  }
  const meanInterval = mean(intervals)
  const cadence: InsightsCadence = {
    meanBlockSeconds: round(meanInterval, 3),
    medianBlockSeconds: round(median(intervals), 3),
    minBlockSeconds: round(intervals.length === 0 ? 0 : Math.min(...intervals), 3),
    maxBlockSeconds: round(intervals.length === 0 ? 0 : Math.max(...intervals), 3),
    jitterSeconds: round(standardDeviation(intervals), 3),
    blocksPerMinute: round(meanInterval > 0 ? 60 / meanInterval : 0, 2),
  }

  /* -- gas ---------------------------------------------------------------- */

  let totalGasUsed = 0n
  let peakGasUsed = 0n
  const utilisations: number[] = []
  for (const block of blocks) {
    totalGasUsed += block.gasUsed
    if (block.gasUsed > peakGasUsed) peakGasUsed = block.gasUsed
    if (block.gasLimit > 0n) {
      utilisations.push((Number(block.gasUsed) / Number(block.gasLimit)) * 100)
    }
  }
  const gas: InsightsGas = {
    totalGasUsed: totalGasUsed.toString(),
    meanGasUsedPerBlock: (totalGasUsed / BigInt(blocks.length)).toString(),
    peakGasUsed: peakGasUsed.toString(),
    gasLimit: newest.gasLimit.toString(),
    meanUtilisationPct: round(mean(utilisations), 4),
    peakUtilisationPct: round(utilisations.length === 0 ? 0 : Math.max(...utilisations), 4),
  }

  /* -- fees --------------------------------------------------------------- */

  const baseFees = blocks
    .map((block) => block.baseFeePerGas)
    .filter((fee): fee is bigint => fee !== null)
  const meanBaseFee =
    baseFees.length === 0
      ? null
      : baseFees.reduce((total, fee) => total + fee, 0n) / BigInt(baseFees.length)
  const minBaseFee = baseFees.reduce<bigint | null>(
    (min, fee) => (min === null || fee < min ? fee : min),
    null,
  )
  const maxBaseFee = baseFees.reduce<bigint | null>(
    (max, fee) => (max === null || fee > max ? fee : max),
    null,
  )
  const fees: InsightsFees = {
    latestBaseFeeWei: newest.baseFeePerGas?.toString() ?? null,
    latestBaseFeeGwei:
      newest.baseFeePerGas === null ? null : formatGwei(newest.baseFeePerGas),
    meanBaseFeeWei: meanBaseFee?.toString() ?? null,
    minBaseFeeWei: minBaseFee?.toString() ?? null,
    maxBaseFeeWei: maxBaseFee?.toString() ?? null,
    suggestedGasPriceWei: suggestedGasPrice.toString(),
    suggestedGasPriceGwei: formatGwei(suggestedGasPrice),
  }

  /* -- activity ----------------------------------------------------------- */

  const senders = new Set<string>()
  const recipients = new Set<string>()
  const transactionTypes: Record<string, number> = {}
  let totalTransactions = 0
  let contractCreations = 0
  let emptyBlocks = 0
  let busiestBlock = newest
  let peakTransactionsInBlock = 0

  for (const block of blocks) {
    const count = block.transactions.length
    totalTransactions += count
    if (count === 0) emptyBlocks++
    if (count > peakTransactionsInBlock) {
      peakTransactionsInBlock = count
      busiestBlock = block
    }
    for (const transaction of block.transactions) {
      senders.add(transaction.from.toLowerCase())
      if (transaction.to === null) {
        contractCreations++
      } else {
        recipients.add(transaction.to.toLowerCase())
      }
      transactionTypes[transaction.type] = (transactionTypes[transaction.type] ?? 0) + 1
    }
  }

  const spanSeconds = Number(newest.timestamp - oldest.timestamp)
  const activity: InsightsActivity = {
    totalTransactions,
    meanTransactionsPerBlock: round(totalTransactions / blocks.length, 3),
    peakTransactionsInBlock,
    emptyBlocks,
    transactionsPerSecond: round(spanSeconds > 0 ? totalTransactions / spanSeconds : 0, 3),
    uniqueSenders: senders.size,
    uniqueRecipients: recipients.size,
    contractCreations,
    transactionTypes,
    depositTransactions: transactionTypes['deposit'] ?? 0,
    busiestBlock: {
      number: busiestBlock.number.toString(),
      transactions: peakTransactionsInBlock,
    },
  }

  /* -- narrative ---------------------------------------------------------- */

  const highlights: string[] = [
    `Sequencer produced ${blocks.length} blocks (#${group(oldest.number)}–#${group(newest.number)}) ` +
      `covering ${group(spanSeconds)}s, at a mean of ${cadence.meanBlockSeconds}s per block ` +
      `(median ${cadence.medianBlockSeconds}s, jitter ±${cadence.jitterSeconds}s).`,
    `Block space is ${gas.meanUtilisationPct}% full on average; the busiest block used ` +
      `${group(peakGasUsed)} of the ${group(newest.gasLimit)} gas limit (${gas.peakUtilisationPct}%).`,
    `${group(totalTransactions)} transactions in the window — ${activity.meanTransactionsPerBlock} per block, ` +
      `${activity.transactionsPerSecond} tx/s — with ${emptyBlocks} empty block(s); ` +
      `block #${group(busiestBlock.number)} was busiest at ${peakTransactionsInBlock} transactions.`,
    `${group(senders.size)} unique sender(s) touched ${group(recipients.size)} distinct recipient(s), ` +
      `and ${group(contractCreations)} transaction(s) deployed a contract.`,
  ]

  if (fees.latestBaseFeeGwei !== null) {
    const range =
      minBaseFee !== null && maxBaseFee !== null && minBaseFee !== maxBaseFee
        ? ` (window range ${formatGwei(minBaseFee)}–${formatGwei(maxBaseFee)} gwei)`
        : ' (flat across the window)'
    highlights.push(
      `Base fee is ${fees.latestBaseFeeGwei} gwei${range}; the node suggests ` +
        `${fees.suggestedGasPriceGwei} gwei for immediate inclusion.`,
    )
  }

  if (activity.depositTransactions > 0) {
    highlights.push(
      `${group(activity.depositTransactions)} of the ${group(totalTransactions)} transactions were OP Stack ` +
        'deposit transactions (L1 → L2 messages), which is traffic bridged from Ethereum Sepolia rather than native L2 activity.',
    )
  }

  const typeBreakdown = Object.entries(transactionTypes)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type} ${count}`)
    .join(', ')
  if (typeBreakdown !== '') {
    highlights.push(`Transaction types in the window: ${typeBreakdown}.`)
  }

  return {
    product: 'GIWA Insights',
    reportVersion: 1,
    generatedAt: now().toISOString(),
    chain: { id: chain.id, name: chain.name, network: chain.network },
    window: {
      fromBlock: oldest.number.toString(),
      toBlock: newest.number.toString(),
      blocks: blocks.length,
      fromTimestamp: Number(oldest.timestamp),
      toTimestamp: Number(newest.timestamp),
      spanSeconds,
    },
    cadence,
    gas,
    fees,
    activity,
    highlights,
    notes: [
      `Computed from ${blocks.length + 2} live JSON-RPC reads against ${chain.name} ` +
        '(eth_blockNumber, eth_gasPrice and one eth_getBlockByNumber per sampled block). ' +
        'No third-party analytics API and no API key are involved.',
      'Statistics describe the sampled window only. A window this short is a snapshot of ' +
        'sequencer behaviour, not a long-run average.',
      'KTD-5 release policy: this report was released as soon as the paying CardVault.charge ' +
        'transaction was included in a sequencer block. The merchant did not wait for the safe ' +
        'block, so a testnet reorg could in principle undo the payment after delivery. That risk ' +
        'is accepted consciously — waiting for finality would take minutes and defeat the purpose ' +
        'of an agent paying for an API call inline.',
    ],
  }
}

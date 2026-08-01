/**
 * Shared test fixtures.
 *
 * Everything the merchant reads from the chain is behind an injected reader, so
 * the whole suite runs offline: these stubs are the only "chain" it ever sees.
 */

import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  numberToHex,
  type Address,
  type Hash,
  type Hex,
} from 'viem'

import { defineMerchantConfig, type MerchantConfig } from '../src/config.js'
import type {
  InsightsBlock,
  InsightsReader,
  InsightsTransaction,
} from '../src/insights.js'
import {
  cardChargedAbi,
  type ChargeLog,
  type ChargeReceipt,
  type ChargeReceiptReader,
} from '../src/verify.js'

/* -------------------------------------------------------------------------- */
/* Addresses                                                                  */
/* -------------------------------------------------------------------------- */

export const MERCHANT_ADDRESS = getAddress('0x1111111111111111111111111111111111111111')
export const VAULT_ADDRESS = getAddress('0x2222222222222222222222222222222222222222')
export const TOKEN_ADDRESS = getAddress('0x3333333333333333333333333333333333333333')
export const VAULT_OWNER = getAddress('0x4444444444444444444444444444444444444444')

/** A lookalike contract that emits a byte-identical `CardCharged`. */
export const IMPOSTOR_VAULT = getAddress('0x5555555555555555555555555555555555555555')

/** Some other merchant, who is not us. */
export const OTHER_MERCHANT = getAddress('0x6666666666666666666666666666666666666666')

/** 1 gUSD in base units (6 decimals). */
export const ONE_GUSD = 1_000_000n

/** A well-formed transaction hash, derived from a seed for readability. */
export function txHash(seed: number): Hash {
  return numberToHex(seed, { size: 32 })
}

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

/** Merchant configuration used by every test unless overridden. */
export function testConfig(
  overrides: Partial<Parameters<typeof defineMerchantConfig>[0]> = {},
): MerchantConfig {
  return defineMerchantConfig({
    merchantAddress: MERCHANT_ADDRESS,
    vaultAddress: VAULT_ADDRESS,
    tokenAddress: TOKEN_ADDRESS,
    baseUrl: 'https://insights.giwacard.test',
    insightsBlockCount: 5,
    insightsConcurrency: 2,
    ...overrides,
  })
}

/* -------------------------------------------------------------------------- */
/* CardCharged logs                                                           */
/* -------------------------------------------------------------------------- */

/** Options for {@link cardChargedLog}. */
export interface CardChargedLogOptions {
  /** Emitting contract. Defaults to the trusted vault. */
  address?: Address
  cardId?: bigint
  vaultOwner?: Address
  merchant?: Address
  amount?: bigint
  released?: bigint
  logIndex?: number
}

/** Encode a real `CardCharged` log, exactly as the EVM would lay it out. */
export function cardChargedLog(options: CardChargedLogOptions = {}): ChargeLog {
  const topics = encodeEventTopics({
    abi: cardChargedAbi,
    eventName: 'CardCharged',
    args: {
      cardId: options.cardId ?? 1n,
      vaultOwner: options.vaultOwner ?? VAULT_OWNER,
      merchant: options.merchant ?? MERCHANT_ADDRESS,
    },
  })
  const data = encodeAbiParameters(
    [
      { name: 'amount', type: 'uint256' },
      { name: 'released', type: 'uint256' },
    ],
    [options.amount ?? ONE_GUSD, options.released ?? 4_000_000n],
  )
  return {
    address: options.address ?? VAULT_ADDRESS,
    topics: topics as readonly Hex[],
    data,
    logIndex: options.logIndex ?? 0,
  }
}

/** A log that is definitely not `CardCharged` (an ERC-20 Transfer topic0). */
export function unrelatedLog(address: Address = VAULT_ADDRESS): ChargeLog {
  return {
    address,
    topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'] as Hex[],
    data: '0x',
    logIndex: 7,
  }
}

/** Options for {@link chargeReceipt}. */
export interface ChargeReceiptOptions {
  hash?: Hash
  status?: 'success' | 'reverted'
  blockNumber?: bigint
  blockHash?: Hash
  logs?: readonly ChargeLog[]
}

/** Build a receipt around a set of logs. */
export function chargeReceipt(options: ChargeReceiptOptions = {}): ChargeReceipt {
  return {
    transactionHash: options.hash ?? txHash(1),
    status: options.status ?? 'success',
    blockNumber: options.blockNumber ?? 1_000n,
    blockHash: options.blockHash ?? txHash(9_999),
    logs: options.logs ?? [cardChargedLog()],
  }
}

/* -------------------------------------------------------------------------- */
/* Receipt reader stub                                                        */
/* -------------------------------------------------------------------------- */

/** Deterministic, offline {@link ChargeReceiptReader}. */
export class StubReceiptReader implements ChargeReceiptReader {
  readonly #receipts = new Map<string, ChargeReceipt>()
  /** Number of times the reader was asked for a receipt. */
  calls = 0
  /** When set, every read throws this instead of answering. */
  failure: unknown = null

  constructor(receipts: readonly ChargeReceipt[] = []) {
    for (const receipt of receipts) this.set(receipt)
  }

  /** Register (or replace) a receipt. */
  set(receipt: ChargeReceipt): this {
    this.#receipts.set(receipt.transactionHash.toLowerCase(), receipt)
    return this
  }

  async getTransactionReceipt(hash: Hash): Promise<ChargeReceipt | null> {
    this.calls++
    if (this.failure !== null) throw this.failure
    return this.#receipts.get(hash.toLowerCase()) ?? null
  }
}

/* -------------------------------------------------------------------------- */
/* Insights reader stub                                                       */
/* -------------------------------------------------------------------------- */

/** Options for {@link makeBlock}. */
export interface MakeBlockOptions {
  number: bigint
  timestamp: bigint
  transactionCount?: number
  gasUsed?: bigint
  gasLimit?: bigint
  baseFeePerGas?: bigint | null
  /** Transaction type name for every transaction in the block. */
  type?: string
  /** Make the last transaction a contract creation (`to === null`). */
  contractCreation?: boolean
}

/** Build one synthetic block with deterministic transactions. */
export function makeBlock(options: MakeBlockOptions): InsightsBlock {
  const count = options.transactionCount ?? 0
  const transactions: InsightsTransaction[] = []
  for (let index = 0; index < count; index++) {
    const isCreation = options.contractCreation === true && index === count - 1
    transactions.push({
      hash: txHash(Number(options.number) * 1_000 + index),
      // Two senders per block, so `uniqueSenders` is a meaningful assertion.
      from: getAddress(`0x${(index % 2 === 0 ? 'aa' : 'bb').repeat(20)}`),
      to: isCreation ? null : getAddress(`0x${'cc'.repeat(20)}`),
      type: options.type ?? 'eip1559',
      gas: 21_000n,
      value: 0n,
    })
  }
  return {
    number: options.number,
    hash: txHash(Number(options.number)),
    timestamp: options.timestamp,
    gasUsed: options.gasUsed ?? BigInt(count) * 21_000n,
    gasLimit: options.gasLimit ?? 30_000_000n,
    baseFeePerGas: options.baseFeePerGas === undefined ? 1_000n : options.baseFeePerGas,
    transactions,
  }
}

/**
 * Build a run of `count` blocks ending at `head`, two seconds apart, with a
 * rotating transaction count so the statistics have something to chew on.
 */
export function makeBlockRun(
  head: bigint,
  count: number,
  txCounts: readonly number[] = [3, 0, 5, 2],
): InsightsBlock[] {
  const blocks: InsightsBlock[] = []
  for (let offset = 0; offset < count; offset++) {
    const number = head - BigInt(count - 1 - offset)
    blocks.push(
      makeBlock({
        number,
        timestamp: 1_800_000_000n + BigInt(offset) * 2n,
        transactionCount: txCounts[offset % txCounts.length] ?? 0,
        baseFeePerGas: 1_000n + BigInt(offset),
      }),
    )
  }
  return blocks
}

/** Deterministic, offline {@link InsightsReader} that records concurrency. */
export class StubInsightsReader implements InsightsReader {
  readonly #blocks = new Map<string, InsightsBlock>()
  readonly #head: bigint
  /** Highest number of simultaneously in-flight `getBlock` calls observed. */
  maxInFlight = 0
  /** Number of `getBlock` calls made. */
  blockCalls = 0
  /** When set, every `getBlock` throws this. */
  failure: unknown = null
  #inFlight = 0

  constructor(blocks: readonly InsightsBlock[], head?: bigint) {
    for (const block of blocks) this.#blocks.set(block.number.toString(), block)
    this.#head = head ?? blocks[blocks.length - 1]?.number ?? 0n
  }

  async getBlockNumber(): Promise<bigint> {
    return this.#head
  }

  async getGasPrice(): Promise<bigint> {
    return 1_050n
  }

  async getBlock(blockNumber: bigint): Promise<InsightsBlock> {
    this.blockCalls++
    this.#inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.#inFlight)
    try {
      // Yield so overlapping calls are actually observable.
      await Promise.resolve()
      if (this.failure !== null) throw this.failure
      const block = this.#blocks.get(blockNumber.toString())
      if (block === undefined) {
        throw new Error(`StubInsightsReader: no block ${blockNumber}`)
      }
      return block
    } finally {
      this.#inFlight--
    }
  }
}

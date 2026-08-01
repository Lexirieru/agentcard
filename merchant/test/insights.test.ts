import { describe, expect, test } from 'bun:test'

import {
  InsightsDataError,
  createViemInsightsReader,
  generateInsightsReport,
  mapWithConcurrency,
} from '../src/insights.js'

import { StubInsightsReader, makeBlock, makeBlockRun, txHash } from './fixtures.js'

const NOW = () => new Date('2026-08-01T12:00:00.000Z')

/** Five blocks ending at #1000, two seconds apart, tx counts 3/0/5/2/3. */
function standardReader(): StubInsightsReader {
  return new StubInsightsReader(makeBlockRun(1_000n, 5))
}

/** Walk a value and collect the paths of anything JSON cannot represent. */
function findBigints(value: unknown, path = '$'): string[] {
  if (typeof value === 'bigint') return [path]
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findBigints(item, `${path}[${index}]`))
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => findBigints(item, `${path}.${key}`))
  }
  return []
}

describe('generateInsightsReport — window', () => {
  test('samples the most recent blockCount blocks', async () => {
    const report = await generateInsightsReport(standardReader(), {
      blockCount: 5,
      now: NOW,
    })
    expect(report.window.fromBlock).toBe('996')
    expect(report.window.toBlock).toBe('1000')
    expect(report.window.blocks).toBe(5)
    expect(report.window.spanSeconds).toBe(8)
    expect(report.window.fromTimestamp).toBe(1_800_000_000)
    expect(report.window.toTimestamp).toBe(1_800_000_008)
  })

  test('clamps to what the chain actually has', async () => {
    const reader = new StubInsightsReader(makeBlockRun(2n, 3))
    const report = await generateInsightsReport(reader, { blockCount: 50, now: NOW })
    expect(report.window.blocks).toBe(3)
    expect(report.window.fromBlock).toBe('0')
    expect(report.window.toBlock).toBe('2')
  })

  test('refuses to report on a chain too short to measure cadence', async () => {
    const genesis = makeBlock({ number: 0n, timestamp: 1_800_000_000n })
    const reader = new StubInsightsReader([genesis], 0n)
    await expect(generateInsightsReport(reader, { now: NOW })).rejects.toBeInstanceOf(
      InsightsDataError,
    )
  })

  test('rejects a nonsensical blockCount', async () => {
    await expect(
      generateInsightsReport(standardReader(), { blockCount: 1 }),
    ).rejects.toBeInstanceOf(TypeError)
  })

  test('stamps the injected clock and chain metadata', async () => {
    const report = await generateInsightsReport(standardReader(), {
      blockCount: 5,
      now: NOW,
      chain: { id: 91_342, name: 'GIWA Sepolia', network: 'giwa-sepolia' },
    })
    expect(report.product).toBe('GIWA Insights')
    expect(report.reportVersion).toBe(1)
    expect(report.generatedAt).toBe('2026-08-01T12:00:00.000Z')
    expect(report.chain).toEqual({ id: 91_342, name: 'GIWA Sepolia', network: 'giwa-sepolia' })
  })
})

describe('generateInsightsReport — statistics', () => {
  test('measures block cadence', async () => {
    const report = await generateInsightsReport(standardReader(), {
      blockCount: 5,
      now: NOW,
    })
    expect(report.cadence.meanBlockSeconds).toBe(2)
    expect(report.cadence.medianBlockSeconds).toBe(2)
    expect(report.cadence.minBlockSeconds).toBe(2)
    expect(report.cadence.maxBlockSeconds).toBe(2)
    expect(report.cadence.jitterSeconds).toBe(0)
    expect(report.cadence.blocksPerMinute).toBe(30)
  })

  test('surfaces jitter when the sequencer is uneven', async () => {
    const reader = new StubInsightsReader([
      makeBlock({ number: 10n, timestamp: 100n, transactionCount: 1 }),
      makeBlock({ number: 11n, timestamp: 102n, transactionCount: 1 }),
      makeBlock({ number: 12n, timestamp: 110n, transactionCount: 1 }),
      makeBlock({ number: 13n, timestamp: 111n, transactionCount: 1 }),
    ])
    const report = await generateInsightsReport(reader, { blockCount: 4, now: NOW })
    expect(report.cadence.minBlockSeconds).toBe(1)
    expect(report.cadence.maxBlockSeconds).toBe(8)
    expect(report.cadence.meanBlockSeconds).toBe(3.667)
    expect(report.cadence.jitterSeconds).toBeGreaterThan(0)
  })

  test('measures gas usage against the block limit', async () => {
    const report = await generateInsightsReport(standardReader(), {
      blockCount: 5,
      now: NOW,
    })
    // 13 transactions * 21_000 gas.
    expect(report.gas.totalGasUsed).toBe('273000')
    expect(report.gas.meanGasUsedPerBlock).toBe('54600')
    expect(report.gas.peakGasUsed).toBe('105000')
    expect(report.gas.gasLimit).toBe('30000000')
    expect(report.gas.meanUtilisationPct).toBe(0.182)
    expect(report.gas.peakUtilisationPct).toBe(0.35)
  })

  test('measures base fee movement and the suggested gas price', async () => {
    const report = await generateInsightsReport(standardReader(), {
      blockCount: 5,
      now: NOW,
    })
    expect(report.fees.latestBaseFeeWei).toBe('1004')
    expect(report.fees.meanBaseFeeWei).toBe('1002')
    expect(report.fees.minBaseFeeWei).toBe('1000')
    expect(report.fees.maxBaseFeeWei).toBe('1004')
    expect(report.fees.suggestedGasPriceWei).toBe('1050')
    expect(report.fees.latestBaseFeeGwei).toBe('0.000001004')
  })

  test('copes with a chain that reports no base fee', async () => {
    const reader = new StubInsightsReader([
      makeBlock({ number: 1n, timestamp: 10n, baseFeePerGas: null }),
      makeBlock({ number: 2n, timestamp: 12n, baseFeePerGas: null }),
    ])
    const report = await generateInsightsReport(reader, { blockCount: 2, now: NOW })
    expect(report.fees.latestBaseFeeWei).toBeNull()
    expect(report.fees.meanBaseFeeWei).toBeNull()
    expect(report.highlights.some((line) => line.includes('Base fee'))).toBe(false)
  })

  test('measures transaction activity', async () => {
    const report = await generateInsightsReport(standardReader(), {
      blockCount: 5,
      now: NOW,
    })
    expect(report.activity.totalTransactions).toBe(13)
    expect(report.activity.meanTransactionsPerBlock).toBe(2.6)
    expect(report.activity.peakTransactionsInBlock).toBe(5)
    expect(report.activity.emptyBlocks).toBe(1)
    expect(report.activity.transactionsPerSecond).toBe(1.625)
    expect(report.activity.uniqueSenders).toBe(2)
    expect(report.activity.uniqueRecipients).toBe(1)
    expect(report.activity.contractCreations).toBe(0)
    expect(report.activity.busiestBlock).toEqual({ number: '998', transactions: 5 })
    expect(report.activity.transactionTypes).toEqual({ eip1559: 13 })
  })

  test('counts contract creations separately from recipients', async () => {
    const reader = new StubInsightsReader([
      makeBlock({ number: 1n, timestamp: 10n, transactionCount: 2, contractCreation: true }),
      makeBlock({ number: 2n, timestamp: 12n, transactionCount: 2, contractCreation: true }),
    ])
    const report = await generateInsightsReport(reader, { blockCount: 2, now: NOW })
    expect(report.activity.contractCreations).toBe(2)
    expect(report.activity.uniqueRecipients).toBe(1)
  })

  test('breaks out OP Stack deposit transactions, which are GIWA-specific traffic', async () => {
    const reader = new StubInsightsReader([
      makeBlock({ number: 1n, timestamp: 10n, transactionCount: 2, type: 'deposit' }),
      makeBlock({ number: 2n, timestamp: 12n, transactionCount: 3, type: 'eip1559' }),
    ])
    const report = await generateInsightsReport(reader, { blockCount: 2, now: NOW })
    expect(report.activity.depositTransactions).toBe(2)
    expect(report.activity.transactionTypes).toEqual({ deposit: 2, eip1559: 3 })
    expect(report.highlights.some((line) => line.includes('deposit transactions'))).toBe(true)
  })
})

describe('generateInsightsReport — the product a buyer receives', () => {
  test('is genuinely informative, not a stub', async () => {
    const report = await generateInsightsReport(standardReader(), {
      blockCount: 5,
      now: NOW,
    })
    expect(report.highlights.length).toBeGreaterThanOrEqual(4)
    for (const line of report.highlights) {
      expect(line.length).toBeGreaterThan(40)
      expect(line).toMatch(/\d/)
    }
    expect(report.highlights.join(' ')).toContain('Sequencer produced 5 blocks')
    expect(report.highlights.join(' ')).toContain('13 transactions')
  })

  test('discloses provenance: live RPC reads, no third-party API', async () => {
    const report = await generateInsightsReport(standardReader(), {
      blockCount: 5,
      now: NOW,
    })
    const notes = report.notes.join(' ')
    expect(notes).toContain('eth_getBlockByNumber')
    expect(notes).toContain('No third-party analytics API and no API key')
  })

  test('states the KTD-5 release policy honestly, in the product itself', async () => {
    const report = await generateInsightsReport(standardReader(), {
      blockCount: 5,
      now: NOW,
    })
    const notes = report.notes.join(' ')
    expect(notes).toContain('KTD-5')
    expect(notes).toContain('sequencer block')
    expect(notes).toContain('did not wait for the safe')
    expect(notes).toContain('reorg')
  })

  test('serialises to JSON without a single bigint leaking through', async () => {
    const report = await generateInsightsReport(standardReader(), {
      blockCount: 5,
      now: NOW,
    })
    expect(findBigints(report)).toEqual([])
    expect(() => JSON.stringify(report)).not.toThrow()
  })
})

describe('generateInsightsReport — RPC behaviour', () => {
  test('honours the concurrency limit against the rate-limited public RPC', async () => {
    const reader = standardReader()
    await generateInsightsReport(reader, { blockCount: 5, concurrency: 2, now: NOW })
    expect(reader.blockCalls).toBe(5)
    expect(reader.maxInFlight).toBeLessThanOrEqual(2)
    expect(reader.maxInFlight).toBeGreaterThan(1)
  })

  test('serialises reads entirely when concurrency is 1', async () => {
    const reader = standardReader()
    await generateInsightsReport(reader, { blockCount: 5, concurrency: 1, now: NOW })
    expect(reader.maxInFlight).toBe(1)
  })

  test('propagates an RPC failure rather than inventing numbers', async () => {
    const reader = standardReader()
    reader.failure = new Error('429 Too Many Requests')
    await expect(
      generateInsightsReport(reader, { blockCount: 5, now: NOW }),
    ).rejects.toThrow('429')
  })

  test('sorts blocks even if the RPC answers out of order', async () => {
    const blocks = makeBlockRun(1_000n, 5)
    const shuffled = [blocks[2], blocks[0], blocks[4], blocks[1], blocks[3]].filter(
      (block): block is NonNullable<typeof block> => block !== undefined,
    )
    const reader = new StubInsightsReader(shuffled, 1_000n)
    const report = await generateInsightsReport(reader, { blockCount: 5, now: NOW })
    expect(report.window.fromBlock).toBe('996')
    expect(report.cadence.meanBlockSeconds).toBe(2)
  })
})

describe('mapWithConcurrency', () => {
  test('preserves input order regardless of completion order', async () => {
    const result = await mapWithConcurrency([5, 1, 3], 3, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value))
      return value * 2
    })
    expect(result).toEqual([10, 2, 6])
  })

  test('handles an empty input', async () => {
    await expect(mapWithConcurrency([], 4, async () => 1)).resolves.toEqual([])
  })

  test('rejects a nonsensical limit', async () => {
    await expect(mapWithConcurrency([1], 0, async () => 1)).rejects.toBeInstanceOf(TypeError)
  })
})

describe('createViemInsightsReader', () => {
  const viemBlock = {
    number: 5n,
    hash: txHash(5),
    timestamp: 1_800_000_000n,
    gasUsed: 21_000n,
    gasLimit: 30_000_000n,
    baseFeePerGas: 1_000n,
    transactions: [
      {
        hash: txHash(1),
        from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const,
        to: null,
        type: 'deposit',
        gas: 21_000n,
        value: 0n,
      },
    ],
  }

  test('maps a viem block onto the narrow reader shape', async () => {
    const reader = createViemInsightsReader({
      getBlockNumber: async () => 5n,
      getGasPrice: async () => 7n,
      getBlock: async () => viemBlock,
    })
    expect(await reader.getBlockNumber()).toBe(5n)
    expect(await reader.getGasPrice()).toBe(7n)
    const block = await reader.getBlock(5n)
    expect(block.number).toBe(5n)
    expect(block.transactions).toHaveLength(1)
    expect(block.transactions[0]?.type).toBe('deposit')
    expect(block.transactions[0]?.to).toBeNull()
  })

  test('refuses a pending block returned for a concrete block number', async () => {
    const reader = createViemInsightsReader({
      getBlockNumber: async () => 5n,
      getGasPrice: async () => 7n,
      getBlock: async () => ({ ...viemBlock, number: null, hash: null }),
    })
    await expect(reader.getBlock(5n)).rejects.toBeInstanceOf(InsightsDataError)
  })
})

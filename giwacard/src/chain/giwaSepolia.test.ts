import { describe, expect, test } from 'bun:test'
import { chainConfig } from 'viem/op-stack'

import {
  GIWA_SEPOLIA_EXPLORER_API_URL,
  GIWA_SEPOLIA_EXPLORER_URL,
  GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL,
  GIWA_SEPOLIA_ID,
  GIWA_SEPOLIA_PRECONFIRMATION_TIME_MS,
  GIWA_SEPOLIA_RPC_URL,
  giwaSepolia,
  giwaSepoliaExplorer,
  giwaSepoliaFlashblocks,
} from './giwaSepolia.js'

describe('giwaSepolia chain definition', () => {
  test('has chain id 91342', () => {
    expect(giwaSepolia.id).toBe(91_342)
    expect(GIWA_SEPOLIA_ID).toBe(91_342)
  })

  test('is named "GIWA Sepolia" and flagged as a testnet', () => {
    expect(giwaSepolia.name).toBe('GIWA Sepolia')
    expect(giwaSepolia.testnet).toBe(true)
  })

  test('uses ETH with 18 decimals as native currency', () => {
    expect(giwaSepolia.nativeCurrency.symbol).toBe('ETH')
    expect(giwaSepolia.nativeCurrency.decimals).toBe(18)
  })

  test('exposes the standard RPC as the default transport url', () => {
    expect(giwaSepolia.rpcUrls.default.http[0]).toBe(
      'https://sepolia-rpc.giwa.io',
    )
    expect(GIWA_SEPOLIA_RPC_URL).toBe('https://sepolia-rpc.giwa.io')
  })

  test('exposes the flashblocks RPC under its own rpcUrls key', () => {
    expect(giwaSepolia.rpcUrls['flashblocks']?.http[0]).toBe(
      'https://sepolia-rpc-flashblocks.giwa.io',
    )
    expect(GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL).toBe(
      'https://sepolia-rpc-flashblocks.giwa.io',
    )
  })

  test('never confuses the two endpoints', () => {
    expect(GIWA_SEPOLIA_RPC_URL).not.toBe(GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL)
  })

  test('points at the Blockscout explorer, with the mandatory /api suffix', () => {
    expect(giwaSepolia.blockExplorers?.default.url).toBe(
      'https://sepolia-explorer.giwa.io',
    )
    expect(giwaSepolia.blockExplorers?.default.apiUrl).toBe(
      'https://sepolia-explorer.giwa.io/api',
    )
    expect(GIWA_SEPOLIA_EXPLORER_URL).toBe('https://sepolia-explorer.giwa.io')
    expect(GIWA_SEPOLIA_EXPLORER_API_URL).toBe(
      `${GIWA_SEPOLIA_EXPLORER_URL}/api`,
    )
  })

  test('all urls are https and parse', () => {
    const urls = [
      GIWA_SEPOLIA_RPC_URL,
      GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL,
      GIWA_SEPOLIA_EXPLORER_URL,
      GIWA_SEPOLIA_EXPLORER_API_URL,
    ]
    for (const url of urls) {
      expect(() => new URL(url)).not.toThrow()
      expect(new URL(url).protocol).toBe('https:')
    }
  })

  test('settles to Ethereum Sepolia', () => {
    expect(giwaSepolia.sourceId).toBe(11_155_111)
  })

  test('inherits the OP Stack chainConfig (formatters, serializers, predeploys)', () => {
    // This is what makes it an OP Stack chain definition rather than a bare
    // defineChain: deposit-transaction formatters come from viem/op-stack.
    expect(giwaSepolia.formatters).toBe(chainConfig.formatters)
    expect(giwaSepolia.serializers).toBe(chainConfig.serializers)
    expect(giwaSepolia.contracts?.['l2ToL1MessagePasser']).toEqual(
      chainConfig.contracts.l2ToL1MessagePasser,
    )
    expect(giwaSepolia.contracts?.['gasPriceOracle']).toEqual(
      chainConfig.contracts.gasPriceOracle,
    )
  })

  test('does not claim L1 contract addresses it has not verified', () => {
    // Guards against someone pasting Base's portal/l2OutputOracle addresses in.
    // (These are not even in the chain's contract type, hence the widening.)
    const contracts = giwaSepolia.contracts as Record<string, unknown>
    expect(contracts['portal']).toBeUndefined()
    expect(contracts['l2OutputOracle']).toBeUndefined()
    expect(contracts['disputeGameFactory']).toBeUndefined()
    expect(contracts['l1StandardBridge']).toBeUndefined()
  })
})

describe('giwaSepoliaFlashblocks', () => {
  test('is the same chain id', () => {
    expect(giwaSepoliaFlashblocks.id).toBe(giwaSepolia.id)
    expect(giwaSepoliaFlashblocks.name).toBe(giwaSepolia.name)
  })

  test('defaults to the flashblocks endpoint', () => {
    expect(giwaSepoliaFlashblocks.rpcUrls.default.http[0]).toBe(
      GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL,
    )
  })

  test('advertises the ~200ms preconfirmation interval', () => {
    expect(giwaSepoliaFlashblocks.experimental_preconfirmationTime).toBe(200)
    expect(GIWA_SEPOLIA_PRECONFIRMATION_TIME_MS).toBe(200)
  })

  test('leaves the standard chain object untouched', () => {
    expect(giwaSepolia.rpcUrls.default.http[0]).toBe(GIWA_SEPOLIA_RPC_URL)
    expect(giwaSepolia.experimental_preconfirmationTime).toBeUndefined()
  })

  test('still reaches the standard endpoint through the named key', () => {
    expect(giwaSepoliaFlashblocks.rpcUrls['flashblocks']?.http[0]).toBe(
      GIWA_SEPOLIA_FLASHBLOCKS_RPC_URL,
    )
  })
})

describe('giwaSepoliaExplorer', () => {
  test('builds tx / address / block links off the explorer root', () => {
    expect(giwaSepoliaExplorer.tx('0xabc')).toBe(
      'https://sepolia-explorer.giwa.io/tx/0xabc',
    )
    expect(giwaSepoliaExplorer.address('0xdef')).toBe(
      'https://sepolia-explorer.giwa.io/address/0xdef',
    )
    expect(giwaSepoliaExplorer.block(123n)).toBe(
      'https://sepolia-explorer.giwa.io/block/123',
    )
  })
})

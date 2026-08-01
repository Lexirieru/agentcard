import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_PORT,
  GUSD_DECIMALS,
  GUSD_SYMBOL,
  MerchantConfigError,
  defineMerchantConfig,
  formatAtomic,
  loadMerchantConfig,
  parsePriceToAtomic,
  type EnvBag,
} from '../src/config.js'

import { MERCHANT_ADDRESS, TOKEN_ADDRESS, VAULT_ADDRESS } from './fixtures.js'

const REQUIRED: EnvBag = {
  MERCHANT_ADDRESS,
  CARD_VAULT_ADDRESS: VAULT_ADDRESS,
  GUSD_ADDRESS: TOKEN_ADDRESS,
}

/** Assert a config failure names the setting at fault. */
function expectConfigError(build: () => unknown, setting: string): MerchantConfigError {
  try {
    build()
  } catch (error) {
    expect(error).toBeInstanceOf(MerchantConfigError)
    expect((error as MerchantConfigError).setting).toBe(setting)
    return error as MerchantConfigError
  }
  throw new Error(`expected a MerchantConfigError for ${setting}`)
}

describe('defineMerchantConfig', () => {
  test('applies the demo defaults', () => {
    const config = defineMerchantConfig({
      merchantAddress: MERCHANT_ADDRESS,
      vaultAddress: VAULT_ADDRESS,
      tokenAddress: TOKEN_ADDRESS,
    })
    expect(config.priceAtomic).toBe(1_000_000n)
    expect(config.priceDisplay).toBe('1')
    expect(config.tokenSymbol).toBe(GUSD_SYMBOL)
    expect(config.tokenDecimals).toBe(GUSD_DECIMALS)
    expect(config.chainId).toBe(91_342)
    expect(config.network).toBe('giwa-sepolia')
    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.baseUrl).toBe(`http://localhost:${DEFAULT_PORT}`)
    expect(config.rpcUrl).toBe('https://sepolia-rpc.giwa.io')
    expect(config.insights.blockCount).toBe(30)
    expect(config.insights.concurrency).toBe(6)
    expect(config.maxTimeoutSeconds).toBe(120)
  })

  test('checksums the addresses it is given', () => {
    const config = defineMerchantConfig({
      merchantAddress: MERCHANT_ADDRESS.toLowerCase(),
      vaultAddress: VAULT_ADDRESS.toLowerCase(),
      tokenAddress: TOKEN_ADDRESS.toLowerCase(),
    })
    expect(config.merchantAddress).toBe(MERCHANT_ADDRESS)
    expect(config.vaultAddress).toBe(VAULT_ADDRESS)
  })

  test('is frozen, so a request handler cannot mutate the price', () => {
    const config = defineMerchantConfig({
      merchantAddress: MERCHANT_ADDRESS,
      vaultAddress: VAULT_ADDRESS,
      tokenAddress: TOKEN_ADDRESS,
    })
    expect(Object.isFrozen(config)).toBe(true)
  })

  test('rejects missing addresses, naming the variable', () => {
    expectConfigError(
      () =>
        defineMerchantConfig({
          merchantAddress: '',
          vaultAddress: VAULT_ADDRESS,
          tokenAddress: TOKEN_ADDRESS,
        }),
      'MERCHANT_ADDRESS',
    )
    expectConfigError(
      () =>
        defineMerchantConfig({
          merchantAddress: MERCHANT_ADDRESS,
          vaultAddress: '',
          tokenAddress: TOKEN_ADDRESS,
        }),
      'CARD_VAULT_ADDRESS',
    )
    expectConfigError(
      () =>
        defineMerchantConfig({
          merchantAddress: MERCHANT_ADDRESS,
          vaultAddress: VAULT_ADDRESS,
          tokenAddress: '',
        }),
      'GUSD_ADDRESS',
    )
  })

  test('rejects a malformed or zero address', () => {
    expectConfigError(
      () =>
        defineMerchantConfig({
          merchantAddress: '0x1234',
          vaultAddress: VAULT_ADDRESS,
          tokenAddress: TOKEN_ADDRESS,
        }),
      'MERCHANT_ADDRESS',
    )
    expectConfigError(
      () =>
        defineMerchantConfig({
          merchantAddress: '0x0000000000000000000000000000000000000000',
          vaultAddress: VAULT_ADDRESS,
          tokenAddress: TOKEN_ADDRESS,
        }),
      'MERCHANT_ADDRESS',
    )
  })

  test('rejects a merchant that is also the vault', () => {
    const error = expectConfigError(
      () =>
        defineMerchantConfig({
          merchantAddress: VAULT_ADDRESS,
          vaultAddress: VAULT_ADDRESS,
          tokenAddress: TOKEN_ADDRESS,
        }),
      'MERCHANT_ADDRESS',
    )
    expect(error.message).toContain('the vault pays the merchant')
  })

  test('rejects an out-of-range port or window size', () => {
    expectConfigError(
      () =>
        defineMerchantConfig({
          merchantAddress: MERCHANT_ADDRESS,
          vaultAddress: VAULT_ADDRESS,
          tokenAddress: TOKEN_ADDRESS,
          port: 70_000,
        }),
      'MERCHANT_PORT',
    )
    expectConfigError(
      () =>
        defineMerchantConfig({
          merchantAddress: MERCHANT_ADDRESS,
          vaultAddress: VAULT_ADDRESS,
          tokenAddress: TOKEN_ADDRESS,
          insightsBlockCount: 1,
        }),
      'MERCHANT_INSIGHTS_BLOCKS',
    )
  })

  test('rejects a non-http base url', () => {
    expectConfigError(
      () =>
        defineMerchantConfig({
          merchantAddress: MERCHANT_ADDRESS,
          vaultAddress: VAULT_ADDRESS,
          tokenAddress: TOKEN_ADDRESS,
          baseUrl: 'ftp://example.com',
        }),
      'MERCHANT_BASE_URL',
    )
  })
})

describe('parsePriceToAtomic', () => {
  test('converts whole and fractional gUSD to 6-decimal base units', () => {
    expect(parsePriceToAtomic('P', '1', 6)).toBe(1_000_000n)
    expect(parsePriceToAtomic('P', '0.5', 6)).toBe(500_000n)
    expect(parsePriceToAtomic('P', '0.000001', 6)).toBe(1n)
    expect(parsePriceToAtomic('P', '12.34', 6)).toBe(12_340_000n)
  })

  test('rejects zero, negatives, exponents and junk', () => {
    for (const bad of ['0', '0.000000', '-1', '1e6', '1.0.0', 'free', '', ' ']) {
      expectConfigError(() => parsePriceToAtomic('P', bad, 6), 'P')
    }
  })

  test('rejects more precision than the token has', () => {
    const error = expectConfigError(() => parsePriceToAtomic('P', '0.0000001', 6), 'P')
    expect(error.message).toContain('only has 6')
  })
})

describe('formatAtomic', () => {
  test('is the inverse of parsePriceToAtomic for representable values', () => {
    expect(formatAtomic(1_000_000n, 6)).toBe('1')
    expect(formatAtomic(500_000n, 6)).toBe('0.5')
    expect(formatAtomic(1n, 6)).toBe('0.000001')
    expect(formatAtomic(0n, 6)).toBe('0')
  })
})

describe('loadMerchantConfig', () => {
  test('reads the required variables', () => {
    const config = loadMerchantConfig(REQUIRED)
    expect(config.merchantAddress).toBe(MERCHANT_ADDRESS)
    expect(config.vaultAddress).toBe(VAULT_ADDRESS)
    expect(config.tokenAddress).toBe(TOKEN_ADDRESS)
  })

  test('reads the optional variables', () => {
    const config = loadMerchantConfig({
      ...REQUIRED,
      MERCHANT_PRICE_GUSD: '2.5',
      MERCHANT_BASE_URL: 'https://insights.example/',
      MERCHANT_PORT: '8080',
      GIWA_RPC_URL: 'https://rpc.example',
      MERCHANT_NETWORK: 'giwa-local',
      MERCHANT_CHAIN_ID: '31337',
      MERCHANT_INSIGHTS_BLOCKS: '10',
      MERCHANT_INSIGHTS_CONCURRENCY: '3',
      MERCHANT_PAYMENT_TIMEOUT_SECONDS: '60',
    })
    expect(config.priceAtomic).toBe(2_500_000n)
    expect(config.baseUrl).toBe('https://insights.example')
    expect(config.port).toBe(8_080)
    expect(config.rpcUrl).toBe('https://rpc.example')
    expect(config.network).toBe('giwa-local')
    expect(config.chainId).toBe(31_337)
    expect(config.insights).toEqual({ blockCount: 10, concurrency: 3 })
    expect(config.maxTimeoutSeconds).toBe(60)
  })

  test('falls back to PORT when MERCHANT_PORT is unset', () => {
    expect(loadMerchantConfig({ ...REQUIRED, PORT: '9000' }).port).toBe(9_000)
    expect(
      loadMerchantConfig({ ...REQUIRED, PORT: '9000', MERCHANT_PORT: '9100' }).port,
    ).toBe(9_100)
  })

  test('defaults baseUrl to the configured port', () => {
    expect(loadMerchantConfig({ ...REQUIRED, MERCHANT_PORT: '9000' }).baseUrl).toBe(
      'http://localhost:9000',
    )
  })

  test('rejects a non-integer numeric variable', () => {
    expectConfigError(
      () => loadMerchantConfig({ ...REQUIRED, MERCHANT_PORT: 'eighty' }),
      'MERCHANT_PORT',
    )
  })

  test('rejects an empty environment, naming the first missing variable', () => {
    expectConfigError(() => loadMerchantConfig({}), 'MERCHANT_ADDRESS')
  })
})

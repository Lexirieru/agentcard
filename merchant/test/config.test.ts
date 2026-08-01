import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_PORT,
  GUSD_DECIMALS,
  GUSD_SYMBOL,
  MerchantConfigError,
  REQUIRED_ENV_VARS,
  defineMerchantConfig,
  formatAtomic,
  loadMerchantConfig,
  parsePriceToAtomic,
  parsePrivateKey,
  type EnvBag,
} from '../src/config.js'

import {
  FOREIGN_PRIVATE_KEY,
  MERCHANT_ADDRESS,
  MERCHANT_PRIVATE_KEY,
  TOKEN_ADDRESS,
  VAULT_ADDRESS,
} from './fixtures.js'

const REQUIRED: EnvBag = {
  MERCHANT_ADDRESS,
  MERCHANT_PRIVATE_KEY,
  CARD_VAULT_ADDRESS: VAULT_ADDRESS,
  GUSD_ADDRESS: TOKEN_ADDRESS,
}

/** The three addresses plus the key, i.e. everything `defineMerchantConfig` needs. */
const BASE = {
  merchantAddress: MERCHANT_ADDRESS,
  merchantPrivateKey: MERCHANT_PRIVATE_KEY,
  vaultAddress: VAULT_ADDRESS,
  tokenAddress: TOKEN_ADDRESS,
} as const

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
      ...BASE,
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
      ...BASE,
      merchantAddress: MERCHANT_ADDRESS.toLowerCase(),
      vaultAddress: VAULT_ADDRESS.toLowerCase(),
      tokenAddress: TOKEN_ADDRESS.toLowerCase(),
    })
    expect(config.merchantAddress).toBe(MERCHANT_ADDRESS)
    expect(config.vaultAddress).toBe(VAULT_ADDRESS)
  })

  test('is frozen, so a request handler cannot mutate the price', () => {
    const config = defineMerchantConfig({
      ...BASE,
    })
    expect(Object.isFrozen(config)).toBe(true)
  })

  test('rejects missing addresses, naming the variable', () => {
    expectConfigError(
      () =>
        defineMerchantConfig({
          ...BASE,
          merchantAddress: '',
        }),
      'MERCHANT_ADDRESS',
    )
    expectConfigError(
      () =>
        defineMerchantConfig({
          ...BASE,
          vaultAddress: '',
        }),
      'CARD_VAULT_ADDRESS',
    )
    expectConfigError(
      () =>
        defineMerchantConfig({
          ...BASE,
          tokenAddress: '',
        }),
      'GUSD_ADDRESS',
    )
  })

  test('rejects a malformed or zero address', () => {
    expectConfigError(
      () =>
        defineMerchantConfig({
          ...BASE,
          merchantAddress: '0x1234',
        }),
      'MERCHANT_ADDRESS',
    )
    expectConfigError(
      () =>
        defineMerchantConfig({
          ...BASE,
          merchantAddress: '0x0000000000000000000000000000000000000000',
        }),
      'MERCHANT_ADDRESS',
    )
  })

  test('exposes the merchant signing key, derived-address checked', () => {
    const config = defineMerchantConfig(BASE)
    expect(config.merchantPrivateKey).toBe(MERCHANT_PRIVATE_KEY)
    expect(config.merchantAddress).toBe(MERCHANT_ADDRESS)
  })

  test('rejects a missing private key, explaining why the merchant needs one', () => {
    const error = expectConfigError(
      () => defineMerchantConfig({ ...BASE, merchantPrivateKey: '' }),
      'MERCHANT_PRIVATE_KEY',
    )
    expect(error.message).toContain('funded EOA')
    expect(error.message).toContain('CardVault.charge')
  })

  test('rejects a malformed private key without echoing it', () => {
    for (const bad of ['0xdeadbeef', 'not-hex', `0x${'11'.repeat(31)}`]) {
      const error = expectConfigError(
        () => defineMerchantConfig({ ...BASE, merchantPrivateKey: bad }),
        'MERCHANT_PRIVATE_KEY',
      )
      expect(error.message).not.toContain(bad)
    }
  })

  test('accepts a key with no 0x prefix', () => {
    const config = defineMerchantConfig({
      ...BASE,
      merchantPrivateKey: MERCHANT_PRIVATE_KEY.slice(2),
    })
    expect(config.merchantPrivateKey).toBe(MERCHANT_PRIVATE_KEY)
  })

  test('rejects a key for some other address, because every charge would revert', () => {
    // CardVault.charge requires msg.sender == card.merchantScope. A merchant
    // holding the wrong key starts fine and then fails every settlement, which
    // is the worst possible time to find out.
    const error = expectConfigError(
      () => defineMerchantConfig({ ...BASE, merchantPrivateKey: FOREIGN_PRIVATE_KEY }),
      'MERCHANT_PRIVATE_KEY',
    )
    expect(error.message).toContain('msg.sender == card.merchantScope')
    expect(error.message).toContain(MERCHANT_ADDRESS)
  })

  test('rejects a merchant that is also the vault', () => {
    const error = expectConfigError(
      () =>
        defineMerchantConfig({
          ...BASE,
          merchantAddress: VAULT_ADDRESS,
        }),
      'MERCHANT_ADDRESS',
    )
    expect(error.message).toContain('the vault pays the merchant')
  })

  test('rejects an out-of-range port or window size', () => {
    expectConfigError(
      () =>
        defineMerchantConfig({
          ...BASE,
          port: 70_000,
        }),
      'MERCHANT_PORT',
    )
    expectConfigError(
      () =>
        defineMerchantConfig({
          ...BASE,
          insightsBlockCount: 1,
        }),
      'MERCHANT_INSIGHTS_BLOCKS',
    )
  })

  test('rejects a non-http base url', () => {
    expectConfigError(
      () =>
        defineMerchantConfig({
          ...BASE,
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

describe('parsePrivateKey', () => {
  test('derives the address of a well-formed key', () => {
    expect(parsePrivateKey('K', MERCHANT_PRIVATE_KEY)).toEqual({
      privateKey: MERCHANT_PRIVATE_KEY,
      address: MERCHANT_ADDRESS,
    })
  })

  test('never puts the key in the error it throws', () => {
    const secret = `0x${'ab'.repeat(20)}`
    const error = expectConfigError(() => parsePrivateKey('K', secret), 'K')
    expect(error.message).not.toContain(secret)
    expect(error.message).not.toContain('ab'.repeat(20))
  })

  test('rejects 32 bytes of hex that is not a valid scalar', () => {
    // Zero is 32 valid hex bytes and is not a private key.
    expectConfigError(() => parsePrivateKey('K', `0x${'00'.repeat(32)}`), 'K')
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

  test('rejects an environment with no MERCHANT_PRIVATE_KEY', () => {
    const { MERCHANT_PRIVATE_KEY: _omitted, ...rest } = REQUIRED
    expectConfigError(() => loadMerchantConfig(rest), 'MERCHANT_PRIVATE_KEY')
  })

  test('REQUIRED_ENV_VARS lists exactly the variables that have no default', () => {
    // The startup banner in `server.ts` prints this list, so it drifting from
    // the validator is how an operator gets told to set the wrong things.
    expect([...REQUIRED_ENV_VARS].sort()).toEqual(
      ['CARD_VAULT_ADDRESS', 'GUSD_ADDRESS', 'MERCHANT_ADDRESS', 'MERCHANT_PRIVATE_KEY'],
    )
    for (const name of REQUIRED_ENV_VARS) {
      const { [name]: _omitted, ...rest } = REQUIRED
      expectConfigError(() => loadMerchantConfig(rest), name)
    }
  })
})

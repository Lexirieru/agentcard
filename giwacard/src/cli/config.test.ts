import { describe, expect, test } from 'bun:test'

import { GIWA_SEPOLIA_RPC_URL } from '../chain/giwaSepolia.js'
import {
  DEFAULT_ETH_FAUCET_URL,
  DEFAULT_POLICY,
  loadCliConfig,
  OWNER_GAS_TARGET_WEI,
  SESSION_KEY_GAS_TARGET_WEI,
} from './config.js'
import { CliError } from './errors.js'

const VAULT = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x2222222222222222222222222222222222222222'
const MERCHANT = '0x3333333333333333333333333333333333333333'
const OTHER = '0x4444444444444444444444444444444444444444'

describe('loadCliConfig', () => {
  test('an empty environment yields nulls and the documented defaults', () => {
    const config = loadCliConfig({})
    expect(config.vaultAddress).toBeNull()
    expect(config.tokenAddress).toBeNull()
    expect(config.merchants).toEqual([])
    expect(config.rpcUrl).toBe(GIWA_SEPOLIA_RPC_URL)
    expect(config.ethFaucetUrl).toBe(DEFAULT_ETH_FAUCET_URL)
    expect(config.debug).toBe(false)
  })

  test('a missing address is null, not a throw — the wizard asks for it', () => {
    expect(loadCliConfig({ GIWACARD_VAULT_ADDRESS: '' }).vaultAddress).toBeNull()
    expect(loadCliConfig({ GIWACARD_VAULT_ADDRESS: '  ' }).vaultAddress).toBeNull()
  })

  test('a malformed address does throw — a typo must not attach you to nothing', () => {
    let thrown: unknown
    try {
      loadCliConfig({ GIWACARD_VAULT_ADDRESS: '0xnope' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe('NOT_CONFIGURED')
    expect((thrown as CliError).message).toContain('GIWACARD_VAULT_ADDRESS')
  })

  test('the demo merchant leads the allowlist', () => {
    // Order is load-bearing: the allowlist is deny-by-default and F2 depends on
    // the demo merchant being in it.
    const config = loadCliConfig({
      GIWACARD_MERCHANT_ADDRESS: MERCHANT,
      GIWACARD_MERCHANTS: `${OTHER},${MERCHANT}`,
    })
    expect(config.merchants).toEqual([MERCHANT, OTHER])
  })

  test('duplicate merchants are collapsed case-insensitively', () => {
    const config = loadCliConfig({
      GIWACARD_MERCHANT_ADDRESS: MERCHANT,
      GIWACARD_MERCHANTS: MERCHANT.toUpperCase().replace('0X', '0x'),
    })
    expect(config.merchants).toEqual([MERCHANT])
  })

  test('reads the vault, token, RPC and faucet overrides', () => {
    const config = loadCliConfig({
      GIWACARD_VAULT_ADDRESS: VAULT,
      GIWACARD_GUSD_ADDRESS: TOKEN,
      GIWACARD_RPC_URL: 'https://rpc.example/',
      GIWACARD_ETH_FAUCET_URL: 'https://faucet.example/',
      GIWACARD_HOME: '/tmp/gc',
      GIWACARD_DEBUG: '1',
    })
    expect(config.vaultAddress).toBe(VAULT)
    expect(config.tokenAddress).toBe(TOKEN)
    expect(config.rpcUrl).toBe('https://rpc.example/')
    expect(config.ethFaucetUrl).toBe('https://faucet.example/')
    expect(config.home).toBe('/tmp/gc')
    expect(config.debug).toBe(true)
  })
})

describe('the shipped defaults', () => {
  test('the default policy is denominated in gUSD base units (6 decimals)', () => {
    expect(DEFAULT_POLICY.capPerCard).toBe(10_000_000n)
    expect(DEFAULT_POLICY.dailyCap).toBe(50_000_000n)
    expect(DEFAULT_POLICY.maxExpiry).toBe(86_400n)
    // The daily cap must allow more than one card, or the two-tier model has no
    // in-policy path worth having.
    expect(DEFAULT_POLICY.dailyCap).toBeGreaterThan(DEFAULT_POLICY.capPerCard)
  })

  test('both gas targets sit inside a day of faucet claims (KTD-6)', () => {
    // The plan budgets 0.005-0.01 ETH per 24h from the faucet.
    const dailyFaucetFloor = 5_000_000_000_000_000n
    expect(OWNER_GAS_TARGET_WEI + SESSION_KEY_GAS_TARGET_WEI).toBeLessThanOrEqual(
      dailyFaucetFloor,
    )
    expect(SESSION_KEY_GAS_TARGET_WEI).toBeGreaterThan(0n)
  })
})

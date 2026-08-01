/**
 * Configuration for the GIWA Insights demo merchant.
 *
 * Everything the facilitator needs to settle a payment lives here: which vault it
 * charges through, which merchant address the cards are scoped to, which token,
 * how much — and, since KTD-9 puts the merchant on the paying end of
 * `CardVault.charge`, **the merchant's own private key**.
 *
 * That key is the one secret this service holds. Two rules follow, and both are
 * enforced below rather than documented and hoped for:
 *
 * - it is **required**, and its absence is a startup error naming the variable,
 *   not a 500 on the first paid request;
 * - the address it derives to must equal `MERCHANT_ADDRESS`, because
 *   `CardVault.charge` requires `msg.sender == card.merchantScope`. A merchant
 *   configured with a key for some other address would revert on every single
 *   charge, and the only symptom would be a stream of failed settlements.
 */

import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem'
import { privateKeyToAddress } from 'viem/accounts'

import { GIWA_SEPOLIA_ID, GIWA_SEPOLIA_NETWORK, GIWA_SEPOLIA_RPC_URL } from './chain.js'

/** gUSD symbol, as minted by `smartcontracts/src/GUSD.sol`. */
export const GUSD_SYMBOL = 'gUSD' as const

/** gUSD decimals. KTD-12: 6, for parity with USDC. */
export const GUSD_DECIMALS = 6 as const

/** Default list price of one GIWA Insights report: 1 gUSD. */
export const DEFAULT_PRICE_GUSD = '1' as const

/** Default TCP port the demo merchant listens on. */
export const DEFAULT_PORT = 4021 as const

/** Default number of recent blocks sampled for a report. */
export const DEFAULT_INSIGHTS_BLOCK_COUNT = 30 as const

/** Default number of concurrent `eth_getBlockByNumber` reads. */
export const DEFAULT_INSIGHTS_CONCURRENCY = 6 as const

/**
 * Default `maxTimeoutSeconds` advertised in payment requirements: how long the
 * client may take between receiving the 402 and presenting a card.
 */
export const DEFAULT_PAYMENT_TIMEOUT_SECONDS = 120 as const

/** Thrown when configuration is missing or malformed. */
export class MerchantConfigError extends Error {
  override readonly name = 'MerchantConfigError'
  /** The setting (or env var) at fault, e.g. `MERCHANT_ADDRESS`. */
  readonly setting: string

  constructor(setting: string, message: string) {
    super(message)
    this.setting = setting
  }
}

/**
 * Rough cost of one `CardVault.charge` on GIWA Sepolia, as a human string.
 *
 * A ~70k-gas L2 transaction at a sub-gwei base fee lands around 1e-5 ETH all in.
 * Quoted in the missing-key error so an operator can size a faucet claim instead
 * of guessing — the answer is "one daily claim covers hundreds of charges",
 * which is a different feeling from "the merchant needs a funded key".
 */
export const APPROX_CHARGE_COST_ETH = '1e-5' as const

/** Raw, unvalidated configuration accepted by {@link defineMerchantConfig}. */
export interface MerchantConfigInput {
  /** Address that charges the card and receives the funds — `merchant` in `CardCharged`. */
  merchantAddress: string
  /**
   * Private key of {@link MerchantConfigInput.merchantAddress}, funded with ETH
   * for gas. Required: the merchant submits the settlement transaction.
   */
  merchantPrivateKey: string
  /** `CardVault` proxy address the merchant charges through. */
  vaultAddress: string
  /** gUSD token address, advertised as the `asset` in requirements. */
  tokenAddress: string
  /** Price in whole gUSD, e.g. `'1'` or `'0.5'`. Default `'1'`. */
  priceGusd?: string
  /** Public base URL used to build the `resource` field. */
  baseUrl?: string
  /** Chain id. Default GIWA Sepolia (91342). */
  chainId?: number
  /** Network slug. Default `giwa-sepolia`. */
  network?: string
  /** RPC endpoint for settlement, receipt reads and insights reads. */
  rpcUrl?: string
  /** TCP port for the standalone server. */
  port?: number
  /** Blocks sampled per report. */
  insightsBlockCount?: number
  /** Concurrent block reads per report. */
  insightsConcurrency?: number
  /** `maxTimeoutSeconds` advertised in requirements. */
  maxTimeoutSeconds?: number
}

/** Validated, frozen merchant configuration. */
export interface MerchantConfig {
  readonly merchantAddress: Address
  /**
   * The merchant's signing key.
   *
   * Never logged, never returned by an endpoint, and never put in an error
   * message — {@link MerchantConfigError} messages quote the *setting name*, not
   * the value, which is why the validators below never interpolate this one.
   */
  readonly merchantPrivateKey: Hex
  readonly vaultAddress: Address
  readonly tokenAddress: Address
  readonly tokenSymbol: string
  readonly tokenDecimals: number
  /** Price in token base units (6-decimal gUSD): 1 gUSD === `1000000n`. */
  readonly priceAtomic: bigint
  /** Human-readable price, e.g. `'1'`. */
  readonly priceDisplay: string
  readonly chainId: number
  readonly network: string
  readonly baseUrl: string
  readonly rpcUrl: string
  readonly port: number
  readonly insights: {
    readonly blockCount: number
    readonly concurrency: number
  }
  readonly maxTimeoutSeconds: number
}

/** Decimal-string shape accepted for a price. No exponents, no signs. */
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/

function requireAddress(setting: string, value: string | undefined): Address {
  if (value === undefined || value.trim() === '') {
    throw new MerchantConfigError(setting, `${setting} is required.`)
  }
  const trimmed = value.trim()
  if (!isAddress(trimmed, { strict: false })) {
    throw new MerchantConfigError(
      setting,
      `${setting} must be a 20-byte hex address, got ${JSON.stringify(trimmed)}.`,
    )
  }
  const checksummed = getAddress(trimmed)
  if (checksummed === '0x0000000000000000000000000000000000000000') {
    throw new MerchantConfigError(setting, `${setting} must not be the zero address.`)
  }
  return checksummed
}

/**
 * Validate the merchant's signing key and derive its address.
 *
 * The key itself never reaches an error message. A malformed key is described by
 * its length and prefix; quoting it would put a live secret in a log line and in
 * whatever collects that log.
 *
 * @throws {MerchantConfigError} when the key is absent or not a 32-byte hex key.
 */
export function parsePrivateKey(
  setting: string,
  value: string | undefined,
): { privateKey: Hex; address: Address } {
  if (value === undefined || value.trim() === '') {
    throw new MerchantConfigError(
      setting,
      `${setting} is required. Since KTD-9 the merchant submits CardVault.charge itself, so ` +
        'it needs a funded EOA: set this to the private key of MERCHANT_ADDRESS and keep ' +
        `that address topped up with GIWA Sepolia ETH. One charge costs about ` +
        `${APPROX_CHARGE_COST_ETH} ETH, so a single daily faucet claim covers hundreds.`,
    )
  }
  const trimmed = value.trim()
  const prefixed = (trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`) as Hex
  if (!isHex(prefixed) || prefixed.length !== 66) {
    throw new MerchantConfigError(
      setting,
      `${setting} must be a 32-byte hex private key (0x + 64 hex chars); got ${prefixed.length - 2} ` +
        'characters after the 0x prefix. The value is not echoed here on purpose.',
    )
  }

  let address: Address
  try {
    address = privateKeyToAddress(prefixed)
  } catch {
    throw new MerchantConfigError(
      setting,
      `${setting} is 32 bytes of hex but is not a valid secp256k1 private key.`,
    )
  }
  return { privateKey: prefixed, address }
}

/**
 * Parse a decimal price into base units without touching floating point.
 *
 * `parseUnits` from viem would do, but rejecting exponent/sign forms up front
 * gives a far better error than a silently truncated `1e-9`.
 */
export function parsePriceToAtomic(
  setting: string,
  value: string,
  decimals: number,
): bigint {
  const trimmed = value.trim()
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new MerchantConfigError(
      setting,
      `${setting} must be a plain decimal number (e.g. "1" or "0.5"), got ${JSON.stringify(value)}.`,
    )
  }
  const [wholePart = '0', fractionPart = ''] = trimmed.split('.')
  if (fractionPart.length > decimals) {
    throw new MerchantConfigError(
      setting,
      `${setting} has ${fractionPart.length} decimal places but the token only has ${decimals}.`,
    )
  }
  const padded = fractionPart.padEnd(decimals, '0')
  const atomic = BigInt(wholePart) * 10n ** BigInt(decimals) + BigInt(padded === '' ? '0' : padded)
  if (atomic <= 0n) {
    throw new MerchantConfigError(setting, `${setting} must be greater than zero.`)
  }
  return atomic
}

function requirePositiveInt(
  setting: string,
  value: number | undefined,
  fallback: number,
  { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new MerchantConfigError(
      setting,
      `${setting} must be an integer between ${min} and ${max}, got ${String(value)}.`,
    )
  }
  return value
}

function requireUrl(setting: string, value: string | undefined, fallback: string): string {
  const raw = value?.trim() === '' ? undefined : value?.trim()
  const candidate = raw ?? fallback
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new MerchantConfigError(
      setting,
      `${setting} must be an absolute URL, got ${JSON.stringify(candidate)}.`,
    )
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MerchantConfigError(
      setting,
      `${setting} must be http(s), got ${parsed.protocol}.`,
    )
  }
  // Normalise away a trailing slash so `${baseUrl}/insights` never doubles up.
  return candidate.replace(/\/+$/, '')
}

/**
 * Validate a configuration object and freeze it.
 *
 * @throws {MerchantConfigError} when any setting is missing or malformed.
 */
export function defineMerchantConfig(input: MerchantConfigInput): MerchantConfig {
  const merchantAddress = requireAddress('MERCHANT_ADDRESS', input.merchantAddress)
  const vaultAddress = requireAddress('CARD_VAULT_ADDRESS', input.vaultAddress)
  const tokenAddress = requireAddress('GUSD_ADDRESS', input.tokenAddress)

  if (merchantAddress === vaultAddress) {
    throw new MerchantConfigError(
      'MERCHANT_ADDRESS',
      'MERCHANT_ADDRESS must differ from CARD_VAULT_ADDRESS: the vault pays the merchant, it is not the merchant.',
    )
  }
  if (merchantAddress === tokenAddress) {
    throw new MerchantConfigError(
      'MERCHANT_ADDRESS',
      'MERCHANT_ADDRESS must differ from GUSD_ADDRESS.',
    )
  }

  const { privateKey, address: signerAddress } = parsePrivateKey(
    'MERCHANT_PRIVATE_KEY',
    input.merchantPrivateKey,
  )
  if (signerAddress !== merchantAddress) {
    throw new MerchantConfigError(
      'MERCHANT_PRIVATE_KEY',
      `MERCHANT_PRIVATE_KEY derives to ${signerAddress}, but MERCHANT_ADDRESS is ` +
        `${merchantAddress}. CardVault.charge requires msg.sender == card.merchantScope, so a ` +
        'key for any other address would revert on every settlement. Fix one of the two.',
    )
  }

  const priceDisplay = (input.priceGusd ?? DEFAULT_PRICE_GUSD).trim()
  const priceAtomic = parsePriceToAtomic('MERCHANT_PRICE_GUSD', priceDisplay, GUSD_DECIMALS)

  const port = requirePositiveInt('MERCHANT_PORT', input.port, DEFAULT_PORT, {
    min: 1,
    max: 65_535,
  })

  return Object.freeze({
    merchantAddress,
    merchantPrivateKey: privateKey,
    vaultAddress,
    tokenAddress,
    tokenSymbol: GUSD_SYMBOL,
    tokenDecimals: GUSD_DECIMALS,
    priceAtomic,
    priceDisplay,
    chainId: requirePositiveInt('MERCHANT_CHAIN_ID', input.chainId, GIWA_SEPOLIA_ID),
    network: input.network?.trim() || GIWA_SEPOLIA_NETWORK,
    baseUrl: requireUrl('MERCHANT_BASE_URL', input.baseUrl, `http://localhost:${port}`),
    rpcUrl: requireUrl('GIWA_RPC_URL', input.rpcUrl, GIWA_SEPOLIA_RPC_URL),
    port,
    insights: Object.freeze({
      blockCount: requirePositiveInt(
        'MERCHANT_INSIGHTS_BLOCKS',
        input.insightsBlockCount,
        DEFAULT_INSIGHTS_BLOCK_COUNT,
        { min: 2, max: 200 },
      ),
      concurrency: requirePositiveInt(
        'MERCHANT_INSIGHTS_CONCURRENCY',
        input.insightsConcurrency,
        DEFAULT_INSIGHTS_CONCURRENCY,
        { min: 1, max: 32 },
      ),
    }),
    maxTimeoutSeconds: requirePositiveInt(
      'MERCHANT_PAYMENT_TIMEOUT_SECONDS',
      input.maxTimeoutSeconds,
      DEFAULT_PAYMENT_TIMEOUT_SECONDS,
      { min: 5, max: 3_600 },
    ),
  })
}

/** Minimal shape of an environment bag; `process.env` satisfies it. */
export type EnvBag = Readonly<Record<string, string | undefined>>

function optionalInt(setting: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed)) {
    throw new MerchantConfigError(
      setting,
      `${setting} must be an integer, got ${JSON.stringify(raw)}.`,
    )
  }
  return parsed
}

/** Environment variables that must be present for the merchant to start. */
export const REQUIRED_ENV_VARS: readonly string[] = [
  'MERCHANT_ADDRESS',
  'MERCHANT_PRIVATE_KEY',
  'CARD_VAULT_ADDRESS',
  'GUSD_ADDRESS',
]

/**
 * Build a {@link MerchantConfig} from environment variables.
 *
 * Required: see {@link REQUIRED_ENV_VARS}.
 * Optional: `MERCHANT_PRICE_GUSD`, `MERCHANT_BASE_URL`, `MERCHANT_PORT` (or
 * `PORT`), `GIWA_RPC_URL`, `MERCHANT_CHAIN_ID`, `MERCHANT_NETWORK`,
 * `MERCHANT_INSIGHTS_BLOCKS`, `MERCHANT_INSIGHTS_CONCURRENCY`,
 * `MERCHANT_PAYMENT_TIMEOUT_SECONDS`.
 *
 * @throws {MerchantConfigError} when a required variable is absent or invalid.
 */
export function loadMerchantConfig(env: EnvBag): MerchantConfig {
  return defineMerchantConfig({
    merchantAddress: env['MERCHANT_ADDRESS'] ?? '',
    merchantPrivateKey: env['MERCHANT_PRIVATE_KEY'] ?? '',
    vaultAddress: env['CARD_VAULT_ADDRESS'] ?? '',
    tokenAddress: env['GUSD_ADDRESS'] ?? '',
    priceGusd: env['MERCHANT_PRICE_GUSD'],
    baseUrl: env['MERCHANT_BASE_URL'],
    chainId: optionalInt('MERCHANT_CHAIN_ID', env['MERCHANT_CHAIN_ID']),
    network: env['MERCHANT_NETWORK'],
    rpcUrl: env['GIWA_RPC_URL'],
    port: optionalInt('MERCHANT_PORT', env['MERCHANT_PORT'] ?? env['PORT']),
    insightsBlockCount: optionalInt(
      'MERCHANT_INSIGHTS_BLOCKS',
      env['MERCHANT_INSIGHTS_BLOCKS'],
    ),
    insightsConcurrency: optionalInt(
      'MERCHANT_INSIGHTS_CONCURRENCY',
      env['MERCHANT_INSIGHTS_CONCURRENCY'],
    ),
    maxTimeoutSeconds: optionalInt(
      'MERCHANT_PAYMENT_TIMEOUT_SECONDS',
      env['MERCHANT_PAYMENT_TIMEOUT_SECONDS'],
    ),
  })
}

/** Format base units as a human decimal string, e.g. `1000000n` → `'1'`. */
export function formatAtomic(amount: bigint, decimals: number): string {
  const negative = amount < 0n
  const absolute = negative ? -amount : amount
  const base = 10n ** BigInt(decimals)
  const whole = absolute / base
  const fraction = (absolute % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  const text = fraction === '' ? whole.toString() : `${whole}.${fraction}`
  return negative ? `-${text}` : text
}

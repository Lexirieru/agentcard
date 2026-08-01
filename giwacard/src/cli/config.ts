import { isAddress, type Address } from 'viem'

import {
  GIWA_SEPOLIA_ETH_FAUCET_URL,
  GIWA_SEPOLIA_RPC_URL,
} from '../chain/giwaSepolia.js'
import { CliError } from './errors.js'

/**
 * Where the CLI learns the deployment it is talking to.
 *
 * KTD-17: `CardVault` is **one canonical multi-owner proxy**, not a contract per
 * user. The wizard therefore *attaches* to an already-deployed address and never
 * deploys anything — balances, escrow, session keys and policies are all keyed
 * by owner address inside that single instance.
 *
 * Consequently there is nothing to discover at runtime, and no sensible default
 * to bake in: a wrong-but-plausible address would send a user's deposit to a
 * contract that is not the vault. Addresses come from the environment (which is
 * how the deployer publishes them), and when one is missing the wizard asks for
 * it and records the answer in the keystore rather than guessing.
 */

/** Environment variables the CLI reads. */
export interface CliEnv {
  /** The canonical `CardVault` proxy. */
  GIWACARD_VAULT_ADDRESS?: string | undefined
  /** The gUSD token the vault settles in. */
  GIWACARD_GUSD_ADDRESS?: string | undefined
  /** The demo merchant seeded into the session key's allowlist (F2). */
  GIWACARD_MERCHANT_ADDRESS?: string | undefined
  /** Extra merchants, comma-separated. */
  GIWACARD_MERCHANTS?: string | undefined
  /** Dedicated RPC endpoint, if the user has one. */
  GIWACARD_RPC_URL?: string | undefined
  /** Where to send a user who needs testnet ETH. */
  GIWACARD_ETH_FAUCET_URL?: string | undefined
  /** Keystore/daemon home. Honoured by the keystore and daemon modules too. */
  GIWACARD_HOME?: string | undefined
  /** Passphrase, for non-interactive runs. Never written by the CLI. */
  GIWACARD_PASSPHRASE?: string | undefined
  /** `1` prints the underlying cause of an unexpected error. */
  GIWACARD_DEBUG?: string | undefined
  /** Honoured by `./theme.ts`. Listed here so the surface is one type. */
  NO_COLOR?: string | undefined
}

/**
 * Where a user gets GIWA Sepolia ETH. Override with `$GIWACARD_ETH_FAUCET_URL`.
 *
 * Re-exported from the chain facts so the CLI and the MCP error taxonomy quote
 * one URL — see {@link GIWA_SEPOLIA_ETH_FAUCET_URL} for why it is the docs index.
 */
export const DEFAULT_ETH_FAUCET_URL = GIWA_SEPOLIA_ETH_FAUCET_URL

/**
 * The gas floor the wizard funds a session key to.
 *
 * KTD-6 budgets N<=20 mint+charge pairs well inside a day's faucet allowance;
 * 0.002 ETH covers that with room to spare on L2 gas, and leaves the rest of a
 * 0.005-0.01 ETH faucet claim with the owner, who submits the approval mints.
 */
export const SESSION_KEY_GAS_TARGET_WEI = 2_000_000_000_000_000n

/** The owner's own gas floor: approval mints, revocations, cancels, deposits. */
export const OWNER_GAS_TARGET_WEI = 3_000_000_000_000_000n

/** Default session policy the wizard proposes. Amounts in gUSD base units. */
export const DEFAULT_POLICY = {
  /** 10 gUSD per card. */
  capPerCard: 10_000_000n,
  /** 50 gUSD per UTC day. */
  dailyCap: 50_000_000n,
  /** 24 hours, in seconds. */
  maxExpiry: 86_400n,
} as const

/** Resolved, validated deployment configuration. */
export interface CliConfig {
  vaultAddress: Address | null
  tokenAddress: Address | null
  /** Merchants to seed into the allowlist. The first is the demo merchant. */
  merchants: readonly Address[]
  rpcUrl: string
  ethFaucetUrl: string
  home: string | undefined
  debug: boolean
}

function parseAddress(raw: string | undefined, variable: string): Address | null {
  if (raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (!isAddress(trimmed)) {
    throw new CliError(
      'NOT_CONFIGURED',
      `$${variable} is set to "${trimmed}", which is not a 0x-prefixed EVM address.`,
      { hint: `Unset $${variable} to be asked for it, or correct the value.` },
    )
  }
  return trimmed as Address
}

function parseAddressList(
  raw: string | undefined,
  variable: string,
): Address[] {
  if (raw === undefined || raw.trim() === '') return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const parsed = parseAddress(entry, variable)
      if (parsed === null) {
        throw new CliError(
          'NOT_CONFIGURED',
          `$${variable} contains an entry that is not an EVM address.`,
        )
      }
      return parsed
    })
}

/**
 * Read the deployment configuration out of the environment.
 *
 * Missing addresses come back as `null` rather than throwing: the wizard's job
 * is to ask for them. A *malformed* address does throw, because silently
 * ignoring a typo'd vault address would attach the user to nothing.
 *
 * @throws {CliError} `NOT_CONFIGURED` when a variable is present but unparseable.
 */
export function loadCliConfig(env: CliEnv = process.env as CliEnv): CliConfig {
  const demoMerchant = parseAddress(
    env.GIWACARD_MERCHANT_ADDRESS,
    'GIWACARD_MERCHANT_ADDRESS',
  )
  const extra = parseAddressList(env.GIWACARD_MERCHANTS, 'GIWACARD_MERCHANTS')
  const merchants: Address[] = []
  // The demo merchant leads: it is the one F2 depends on, and the allowlist is
  // deny-by-default, so its position is the difference between a working demo
  // and MERCHANT_OUT_OF_SCOPE on the first card.
  if (demoMerchant !== null) merchants.push(demoMerchant)
  for (const entry of extra) {
    if (!merchants.some((known) => known.toLowerCase() === entry.toLowerCase())) {
      merchants.push(entry)
    }
  }

  return {
    vaultAddress: parseAddress(env.GIWACARD_VAULT_ADDRESS, 'GIWACARD_VAULT_ADDRESS'),
    tokenAddress: parseAddress(env.GIWACARD_GUSD_ADDRESS, 'GIWACARD_GUSD_ADDRESS'),
    merchants,
    rpcUrl: env.GIWACARD_RPC_URL?.trim() || GIWA_SEPOLIA_RPC_URL,
    ethFaucetUrl: env.GIWACARD_ETH_FAUCET_URL?.trim() || DEFAULT_ETH_FAUCET_URL,
    home: env.GIWACARD_HOME?.trim() || undefined,
    debug: env.GIWACARD_DEBUG === '1',
  }
}

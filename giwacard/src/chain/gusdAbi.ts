/**
 * Minimal hand-written ABI for `gUSD` (`smartcontracts/src/GUSD.sol`).
 *
 * Same discipline as `cardVaultAbi.ts`: only the fragments this package calls,
 * plus every custom error, because viem needs the full error set to decode
 * `FaucetCooldownActive` into the specific "you already claimed today" message
 * the CLI owes the user instead of an opaque `0x…` blob.
 *
 * Keep in lockstep with the Solidity. Drift shows up as a decode failure at
 * runtime, not at compile time.
 */

/** gUSD decimals. `decimals()` is `pure` in the contract, so this is constant. */
export const GUSD_DECIMALS = 6 as const

/** Ticker shown next to amounts. */
export const GUSD_SYMBOL = 'gUSD' as const

/** `GUSD.FAUCET_AMOUNT` — 100 gUSD, in base units. */
export const GUSD_FAUCET_AMOUNT = 100n * 10n ** BigInt(GUSD_DECIMALS)

/** `GUSD.FAUCET_COOLDOWN` — 24 hours, in seconds. */
export const GUSD_FAUCET_COOLDOWN_SECONDS = 24n * 60n * 60n

/** The fragments of `GUSD` this package calls or decodes. */
export const gusdAbi = [
  /* ---------------------------------------------------------------- faucet */
  {
    type: 'function',
    name: 'claimFaucet',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'faucetAvailableAt',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'lastFaucetClaim',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'FAUCET_AMOUNT',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'FAUCET_COOLDOWN',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },

  /* ----------------------------------------------------------------- erc20 */
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'pure',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },

  /* ---------------------------------------------------------------- events */
  {
    type: 'event',
    name: 'FaucetClaimed',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },

  /* ---------------------------------------------------------------- errors */
  {
    type: 'error',
    name: 'FaucetCooldownActive',
    inputs: [{ name: 'availableAt', type: 'uint256' }],
  },
  { type: 'error', name: 'InvalidRecipient', inputs: [] },
] as const

/** The ABI type, for callers that need to name it. */
export type GusdAbi = typeof gusdAbi

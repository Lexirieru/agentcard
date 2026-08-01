import type { Hex } from './keystore.js'

/**
 * Minimal hand-written ABI for `CardVault` (`smartcontracts/src/CardVault.sol`).
 *
 * Only the fragments this package actually calls are listed. A hand-written ABI
 * is deliberate: a generated Foundry artifact is ~40 KB of JSON that would ship
 * inside `npx giwacard`, and every extra fragment is a function some caller
 * might reach for that this package has no business exposing. The custom errors
 * *are* all listed, because viem needs the full error set to decode a revert
 * into the agent-facing taxonomy in `src/mcp/errors.ts` — an unlisted error
 * decodes as an opaque `0x…` blob and loses the actionable message.
 *
 * Keep this file in lockstep with the Solidity. A drift shows up as a decode
 * failure at runtime, not at compile time.
 */

/* -------------------------------------------------------------------------- */
/* CardStatus                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `CardStatus` from `CardTypes.sol`, as the `uint8` the ABI encodes it to.
 *
 * A card is minted `Active` and leaves that state exactly once — the status
 * *is* the replay nonce, which is why `Used` is terminal.
 */
export const CardStatus = {
  /** Card id was never minted. */
  None: 0,
  /** Escrow is locked and the card can still be charged. */
  Active: 1,
  /** The card was charged; escrow settled and the remainder released. */
  Used: 2,
  /** The card outlived its expiry and someone reaped it. */
  Expired: 3,
  /** The vault owner cancelled the card before it was charged. */
  Revoked: 4,
} as const

/** Numeric `CardStatus` value, as returned by `getCard`. */
export type CardStatusValue = (typeof CardStatus)[keyof typeof CardStatus]

/** Lower-case name of a {@link CardStatus} value, used in tool results. */
export type CardStatusName =
  | 'none'
  | 'active'
  | 'used'
  | 'expired'
  | 'revoked'

const CARD_STATUS_NAMES: readonly CardStatusName[] = [
  'none',
  'active',
  'used',
  'expired',
  'revoked',
]

/**
 * Map the onchain `uint8` to its lower-case name.
 *
 * Anything outside the enum reads as `none` rather than throwing: a vault
 * upgraded to a newer `CardStatus` must not crash an older client mid-read.
 */
export function cardStatusName(status: number): CardStatusName {
  return CARD_STATUS_NAMES[status] ?? 'none'
}

/* -------------------------------------------------------------------------- */
/* Decoded shapes                                                             */
/* -------------------------------------------------------------------------- */

/** `Card` struct as viem decodes it from `getCard`. */
export interface VaultCard {
  vaultOwner: Hex
  agent: Hex
  token: Hex
  cap: bigint
  merchantScope: Hex
  expiry: bigint
  status: number
}

/** `SessionPolicy` struct as viem decodes it from `sessionPolicy`. */
export interface VaultSessionPolicy {
  capPerCard: bigint
  dailyCap: bigint
  maxExpiry: bigint
  active: boolean
}

/**
 * `CardApproval` struct — the EIP-712 payload a vault owner signs to authorise
 * a card that breaks session policy.
 *
 * The MCP server stores this shape (with the `bigint`s as decimal strings) in
 * the daemon's approval queue, so the owner's client signs exactly the terms
 * the relay later submits.
 */
export interface CardApproval {
  vaultOwner: Hex
  agent: Hex
  token: Hex
  cap: bigint
  merchantScope: Hex
  expiry: bigint
  approvalId: Hex
}

/** EIP-712 domain name the vault initialises itself with. */
export const CARD_VAULT_EIP712_DOMAIN_NAME = 'GiwaCard CardVault' as const
/** EIP-712 domain version the vault initialises itself with. */
export const CARD_VAULT_EIP712_DOMAIN_VERSION = '1' as const

/**
 * EIP-712 types for {@link CardApproval}, in the field order the contract's
 * `_CARD_APPROVAL_TYPEHASH` commits to. Reordering these silently produces a
 * signature the vault rejects.
 */
export const CARD_APPROVAL_EIP712_TYPES = {
  CardApproval: [
    { name: 'vaultOwner', type: 'address' },
    { name: 'agent', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'cap', type: 'uint256' },
    { name: 'merchantScope', type: 'address' },
    { name: 'expiry', type: 'uint64' },
    { name: 'approvalId', type: 'bytes32' },
  ],
} as const

/* -------------------------------------------------------------------------- */
/* ABI                                                                        */
/* -------------------------------------------------------------------------- */

const CARD_COMPONENTS = [
  { name: 'vaultOwner', type: 'address' },
  { name: 'agent', type: 'address' },
  { name: 'token', type: 'address' },
  { name: 'cap', type: 'uint256' },
  { name: 'merchantScope', type: 'address' },
  { name: 'expiry', type: 'uint64' },
  { name: 'status', type: 'uint8' },
] as const

const SESSION_POLICY_COMPONENTS = [
  { name: 'capPerCard', type: 'uint256' },
  { name: 'dailyCap', type: 'uint256' },
  { name: 'maxExpiry', type: 'uint64' },
  { name: 'active', type: 'bool' },
] as const

const CARD_APPROVAL_COMPONENTS = [
  { name: 'vaultOwner', type: 'address' },
  { name: 'agent', type: 'address' },
  { name: 'token', type: 'address' },
  { name: 'cap', type: 'uint256' },
  { name: 'merchantScope', type: 'address' },
  { name: 'expiry', type: 'uint64' },
  { name: 'approvalId', type: 'bytes32' },
] as const

/** The fragments of `CardVault` this package calls, decodes or listens for. */
export const cardVaultAbi = [
  /* --------------------------------------------------- custody (owner-only) */
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [],
  },

  /* ---------------------------------------------- session keys (owner-only) */
  {
    type: 'function',
    name: 'registerSessionKey',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sessionKey', type: 'address' },
      { name: 'capPerCard', type: 'uint256' },
      { name: 'dailyCap', type: 'uint256' },
      { name: 'maxExpiry', type: 'uint64' },
      { name: 'merchants', type: 'address[]' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setSessionKeyMerchant',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sessionKey', type: 'address' },
      { name: 'merchant', type: 'address' },
      { name: 'allowed', type: 'bool' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'revokeSessionKey',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'sessionKey', type: 'address' }],
    outputs: [],
  },

  /* ---------------------------------------------------------------- writes */
  {
    type: 'function',
    name: 'mintCard',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'vaultOwner', type: 'address' },
      { name: 'cap', type: 'uint256' },
      { name: 'merchantScope', type: 'address' },
      { name: 'expiry', type: 'uint64' },
    ],
    outputs: [{ name: 'cardId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'mintCardWithApproval',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'approval', type: 'tuple', components: CARD_APPROVAL_COMPONENTS },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: 'cardId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'charge',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'cardId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'cancelCard',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'cardId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'releaseExpired',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'cardId', type: 'uint256' }],
    outputs: [],
  },

  /* ----------------------------------------------------------------- views */
  {
    type: 'function',
    name: 'getCard',
    stateMutability: 'view',
    inputs: [{ name: 'cardId', type: 'uint256' }],
    outputs: [{ name: '', type: 'tuple', components: CARD_COMPONENTS }],
  },
  {
    type: 'function',
    name: 'sessionPolicy',
    stateMutability: 'view',
    inputs: [
      { name: 'vaultOwner', type: 'address' },
      { name: 'sessionKey', type: 'address' },
    ],
    outputs: [
      { name: '', type: 'tuple', components: SESSION_POLICY_COMPONENTS },
    ],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'vaultOwner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'escrowedOf',
    stateMutability: 'view',
    inputs: [{ name: 'vaultOwner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'availableBalanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'vaultOwner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'isMerchantAllowed',
    stateMutability: 'view',
    inputs: [
      { name: 'vaultOwner', type: 'address' },
      { name: 'sessionKey', type: 'address' },
      { name: 'merchant', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'mintedOnDay',
    stateMutability: 'view',
    inputs: [
      { name: 'vaultOwner', type: 'address' },
      { name: 'sessionKey', type: 'address' },
      { name: 'day', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'currentDay',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'paymentToken',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'lastCardId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'isApprovalUsed',
    stateMutability: 'view',
    inputs: [
      { name: 'vaultOwner', type: 'address' },
      { name: 'approvalId', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'hashCardApproval',
    stateMutability: 'view',
    inputs: [
      { name: 'approval', type: 'tuple', components: CARD_APPROVAL_COMPONENTS },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },

  /* ---------------------------------------------------------------- events */
  {
    type: 'event',
    name: 'Deposited',
    inputs: [
      { name: 'vaultOwner', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Withdrawn',
    inputs: [
      { name: 'vaultOwner', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SessionKeyRegistered',
    inputs: [
      { name: 'vaultOwner', type: 'address', indexed: true },
      { name: 'sessionKey', type: 'address', indexed: true },
      { name: 'capPerCard', type: 'uint256', indexed: false },
      { name: 'dailyCap', type: 'uint256', indexed: false },
      { name: 'maxExpiry', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SessionKeyMerchantSet',
    inputs: [
      { name: 'vaultOwner', type: 'address', indexed: true },
      { name: 'sessionKey', type: 'address', indexed: true },
      { name: 'merchant', type: 'address', indexed: true },
      { name: 'allowed', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'CardMinted',
    inputs: [
      { name: 'cardId', type: 'uint256', indexed: true },
      { name: 'vaultOwner', type: 'address', indexed: true },
      { name: 'agent', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: false },
      { name: 'cap', type: 'uint256', indexed: false },
      { name: 'merchantScope', type: 'address', indexed: false },
      { name: 'expiry', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'CardCharged',
    inputs: [
      { name: 'cardId', type: 'uint256', indexed: true },
      { name: 'vaultOwner', type: 'address', indexed: true },
      { name: 'merchant', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'released', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'CardCancelled',
    inputs: [
      { name: 'cardId', type: 'uint256', indexed: true },
      { name: 'vaultOwner', type: 'address', indexed: true },
      { name: 'released', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'CardExpiredReleased',
    inputs: [
      { name: 'cardId', type: 'uint256', indexed: true },
      { name: 'vaultOwner', type: 'address', indexed: true },
      { name: 'caller', type: 'address', indexed: true },
      { name: 'released', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SessionKeyRevoked',
    inputs: [
      { name: 'vaultOwner', type: 'address', indexed: true },
      { name: 'sessionKey', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'ApprovalConsumed',
    inputs: [
      { name: 'vaultOwner', type: 'address', indexed: true },
      { name: 'approvalId', type: 'bytes32', indexed: true },
      { name: 'cardId', type: 'uint256', indexed: true },
    ],
  },

  /* ---------------------------------------------------------------- errors */
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'ZeroAmount', inputs: [] },
  {
    type: 'error',
    name: 'UnsupportedToken',
    inputs: [{ name: 'token', type: 'address' }],
  },
  {
    type: 'error',
    name: 'InsufficientAvailableBalance',
    inputs: [
      { name: 'available', type: 'uint256' },
      { name: 'required', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'SessionKeyNotActive',
    inputs: [
      { name: 'vaultOwner', type: 'address' },
      { name: 'sessionKey', type: 'address' },
    ],
  },
  {
    type: 'error',
    name: 'CapPerCardExceeded',
    inputs: [
      { name: 'cap', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'DailyCapExceeded',
    inputs: [
      { name: 'wouldBeTotal', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'MerchantNotAllowed',
    inputs: [
      { name: 'vaultOwner', type: 'address' },
      { name: 'sessionKey', type: 'address' },
      { name: 'merchant', type: 'address' },
    ],
  },
  {
    type: 'error',
    name: 'ExpiryInPast',
    inputs: [{ name: 'expiry', type: 'uint64' }],
  },
  {
    type: 'error',
    name: 'ExpiryTooFar',
    inputs: [
      { name: 'expiry', type: 'uint64' },
      { name: 'latestAllowed', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'CardNotActive',
    inputs: [
      { name: 'cardId', type: 'uint256' },
      { name: 'status', type: 'uint8' },
    ],
  },
  {
    type: 'error',
    name: 'CardExpired',
    inputs: [
      { name: 'cardId', type: 'uint256' },
      { name: 'expiry', type: 'uint64' },
    ],
  },
  {
    type: 'error',
    name: 'CardNotExpired',
    inputs: [
      { name: 'cardId', type: 'uint256' },
      { name: 'expiry', type: 'uint64' },
    ],
  },
  {
    type: 'error',
    name: 'NotCardOwner',
    inputs: [
      { name: 'cardId', type: 'uint256' },
      { name: 'caller', type: 'address' },
      { name: 'vaultOwner', type: 'address' },
    ],
  },
  {
    type: 'error',
    name: 'MerchantScopeMismatch',
    inputs: [
      { name: 'cardId', type: 'uint256' },
      { name: 'caller', type: 'address' },
      { name: 'merchantScope', type: 'address' },
    ],
  },
  {
    type: 'error',
    name: 'ChargeExceedsCap',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'cap', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'InvalidSignature', inputs: [] },
  {
    type: 'error',
    name: 'ApprovalAlreadyUsed',
    inputs: [
      { name: 'vaultOwner', type: 'address' },
      { name: 'approvalId', type: 'bytes32' },
    ],
  },
] as const

/** The ABI type, for callers that need to name it. */
export type CardVaultAbi = typeof cardVaultAbi

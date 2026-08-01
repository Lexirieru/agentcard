import type { Abi } from "viem";

/**
 * Hand-written ABI slice of `CardVault` (smartcontracts/src/CardVault.sol).
 *
 * Only the fragments the dashboard reads, writes or decodes are listed. The
 * event parameter order is load-bearing: viem builds the topic filter from it,
 * so a reordered input silently produces zero logs rather than a type error.
 * Keep this in lockstep with the Solidity.
 */

/* -------------------------------------------------------------------------- */
/* Card lifecycle                                                             */
/* -------------------------------------------------------------------------- */

/** `CardStatus` from CardTypes.sol, as the `uint8` the ABI encodes it to. */
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
} as const;

export type CardStatusValue = (typeof CardStatus)[keyof typeof CardStatus];

/** `Card` struct as viem decodes it from `getCard`. */
export interface VaultCard {
  vaultOwner: `0x${string}`;
  agent: `0x${string}`;
  token: `0x${string}`;
  cap: bigint;
  merchantScope: `0x${string}`;
  expiry: bigint;
  status: number;
}

/* -------------------------------------------------------------------------- */
/* Session keys                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `SessionPolicy` from CardTypes.sol, as viem decodes it from `sessionPolicy`.
 *
 * A key that was never registered decodes as all-zero with `active: false`,
 * which is indistinguishable from a revoked key whose caps were zero. That is
 * the contract's own shape, not a lossy read — the dashboard only ever asks
 * about keys it saw a `SessionKeyRegistered` log for.
 */
export interface VaultSessionPolicy {
  capPerCard: bigint;
  dailyCap: bigint;
  maxExpiry: bigint;
  active: boolean;
}

/* -------------------------------------------------------------------------- */
/* EIP-712                                                                    */
/* -------------------------------------------------------------------------- */

/** Domain name the vault initialises {@link EIP712Upgradeable} with. */
export const CARD_VAULT_EIP712_DOMAIN_NAME = "GiwaCard CardVault" as const;
/** Domain version the vault initialises {@link EIP712Upgradeable} with. */
export const CARD_VAULT_EIP712_DOMAIN_VERSION = "1" as const;

/**
 * EIP-712 types for `CardApproval`, in the exact field order the contract's
 * `_CARD_APPROVAL_TYPEHASH` commits to. Reordering these still signs — it just
 * produces a signature `mintCardWithApproval` rejects as `InvalidSignature`.
 */
export const CARD_APPROVAL_EIP712_TYPES = {
  CardApproval: [
    { name: "vaultOwner", type: "address" },
    { name: "agent", type: "address" },
    { name: "token", type: "address" },
    { name: "cap", type: "uint256" },
    { name: "merchantScope", type: "address" },
    { name: "expiry", type: "uint64" },
    { name: "approvalId", type: "bytes32" },
  ],
} as const;

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

export const SESSION_KEY_REGISTERED_EVENT = {
  type: "event",
  name: "SessionKeyRegistered",
  inputs: [
    { name: "vaultOwner", type: "address", indexed: true },
    { name: "sessionKey", type: "address", indexed: true },
    { name: "capPerCard", type: "uint256", indexed: false },
    { name: "dailyCap", type: "uint256", indexed: false },
    { name: "maxExpiry", type: "uint64", indexed: false },
  ],
} as const;

export const SESSION_KEY_MERCHANT_SET_EVENT = {
  type: "event",
  name: "SessionKeyMerchantSet",
  inputs: [
    { name: "vaultOwner", type: "address", indexed: true },
    { name: "sessionKey", type: "address", indexed: true },
    { name: "merchant", type: "address", indexed: true },
    { name: "allowed", type: "bool", indexed: false },
  ],
} as const;

export const SESSION_KEY_REVOKED_EVENT = {
  type: "event",
  name: "SessionKeyRevoked",
  inputs: [
    { name: "vaultOwner", type: "address", indexed: true },
    { name: "sessionKey", type: "address", indexed: true },
  ],
} as const;

export const CARD_MINTED_EVENT = {
  type: "event",
  name: "CardMinted",
  inputs: [
    { name: "cardId", type: "uint256", indexed: true },
    { name: "vaultOwner", type: "address", indexed: true },
    { name: "agent", type: "address", indexed: true },
    { name: "token", type: "address", indexed: false },
    { name: "cap", type: "uint256", indexed: false },
    { name: "merchantScope", type: "address", indexed: false },
    { name: "expiry", type: "uint64", indexed: false },
  ],
} as const;

export const CARD_CHARGED_EVENT = {
  type: "event",
  name: "CardCharged",
  inputs: [
    { name: "cardId", type: "uint256", indexed: true },
    { name: "vaultOwner", type: "address", indexed: true },
    { name: "merchant", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "released", type: "uint256", indexed: false },
  ],
} as const;

export const CARD_CANCELLED_EVENT = {
  type: "event",
  name: "CardCancelled",
  inputs: [
    { name: "cardId", type: "uint256", indexed: true },
    { name: "vaultOwner", type: "address", indexed: true },
    { name: "released", type: "uint256", indexed: false },
  ],
} as const;

export const CARD_EXPIRED_RELEASED_EVENT = {
  type: "event",
  name: "CardExpiredReleased",
  inputs: [
    { name: "cardId", type: "uint256", indexed: true },
    { name: "vaultOwner", type: "address", indexed: true },
    { name: "caller", type: "address", indexed: true },
    { name: "released", type: "uint256", indexed: false },
  ],
} as const;

/* -------------------------------------------------------------------------- */
/* Contract ABI                                                               */
/* -------------------------------------------------------------------------- */

const CARD_COMPONENTS = [
  { name: "vaultOwner", type: "address" },
  { name: "agent", type: "address" },
  { name: "token", type: "address" },
  { name: "cap", type: "uint256" },
  { name: "merchantScope", type: "address" },
  { name: "expiry", type: "uint64" },
  { name: "status", type: "uint8" },
] as const;

const SESSION_POLICY_COMPONENTS = [
  { name: "capPerCard", type: "uint256" },
  { name: "dailyCap", type: "uint256" },
  { name: "maxExpiry", type: "uint64" },
  { name: "active", type: "bool" },
] as const;

const CARD_APPROVAL_COMPONENTS = [
  { name: "vaultOwner", type: "address" },
  { name: "agent", type: "address" },
  { name: "token", type: "address" },
  { name: "cap", type: "uint256" },
  { name: "merchantScope", type: "address" },
  { name: "expiry", type: "uint64" },
  { name: "approvalId", type: "bytes32" },
] as const;

export const cardVaultAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "vaultOwner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "escrowedOf",
    stateMutability: "view",
    inputs: [{ name: "vaultOwner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "availableBalanceOf",
    stateMutability: "view",
    inputs: [{ name: "vaultOwner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "paymentToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getCard",
    stateMutability: "view",
    inputs: [{ name: "cardId", type: "uint256" }],
    outputs: [{ name: "", type: "tuple", components: CARD_COMPONENTS }],
  },
  {
    type: "function",
    name: "isApprovalUsed",
    stateMutability: "view",
    inputs: [
      { name: "vaultOwner", type: "address" },
      { name: "approvalId", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "mintCardWithApproval",
    stateMutability: "nonpayable",
    inputs: [
      { name: "approval", type: "tuple", components: CARD_APPROVAL_COMPONENTS },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "cardId", type: "uint256" }],
  },
  {
    type: "function",
    name: "cancelCard",
    stateMutability: "nonpayable",
    inputs: [{ name: "cardId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "sessionPolicy",
    stateMutability: "view",
    inputs: [
      { name: "vaultOwner", type: "address" },
      { name: "sessionKey", type: "address" },
    ],
    outputs: [{ name: "", type: "tuple", components: SESSION_POLICY_COMPONENTS }],
  },
  {
    type: "function",
    name: "isMerchantAllowed",
    stateMutability: "view",
    inputs: [
      { name: "vaultOwner", type: "address" },
      { name: "sessionKey", type: "address" },
      { name: "merchant", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "registerSessionKey",
    stateMutability: "nonpayable",
    inputs: [
      { name: "sessionKey", type: "address" },
      { name: "capPerCard", type: "uint256" },
      { name: "dailyCap", type: "uint256" },
      { name: "maxExpiry", type: "uint64" },
      { name: "merchants", type: "address[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setSessionKeyMerchant",
    stateMutability: "nonpayable",
    inputs: [
      { name: "sessionKey", type: "address" },
      { name: "merchant", type: "address" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revokeSessionKey",
    stateMutability: "nonpayable",
    inputs: [{ name: "sessionKey", type: "address" }],
    outputs: [],
  },
  SESSION_KEY_REGISTERED_EVENT,
  SESSION_KEY_MERCHANT_SET_EVENT,
  SESSION_KEY_REVOKED_EVENT,
  CARD_MINTED_EVENT,
  CARD_CHARGED_EVENT,
  CARD_CANCELLED_EVENT,
  CARD_EXPIRED_RELEASED_EVENT,
] as const satisfies Abi;

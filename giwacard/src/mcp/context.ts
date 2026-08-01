import type { Abi, Address, Hex, Log } from 'viem'

import type { ApprovalClient } from './approvals.js'

/**
 * Everything a GiwaCard MCP tool is allowed to touch, in one injected object.
 *
 * The chain clients are declared here as the *narrowest structural interfaces*
 * the tools actually use rather than as viem's `PublicClient` / `WalletClient`.
 * Two reasons, and the second is the important one:
 *
 * 1. A test can supply an object literal with three methods instead of standing
 *    up a viem client, which is what makes "mock chain reads/writes, never hit a
 *    live RPC" cheap enough to do everywhere.
 * 2. It is a hard, compiler-checked ceiling on what a tool can do. A tool holding
 *    a real `WalletClient` could `signMessage` or `signTypedData`; a tool holding
 *    a {@link VaultWalletClient} demonstrably cannot, because the method is not
 *    on the type. R10b says the agent never receives anything signable, and the
 *    cheapest way to keep that true is for the signing surface not to exist here.
 *
 * A real {@link import('../chain/clients.js').GiwaPublicClient} satisfies
 * {@link VaultPublicClient} structurally, so production wiring is a plain
 * assignment.
 */

/** A transaction receipt, reduced to what the mint and charge paths read. */
export interface VaultReceipt {
  status: 'success' | 'reverted'
  transactionHash: Hex
  logs: readonly Log[]
  blockNumber?: bigint
}

/** Read side of the chain: contract views, gas balance, receipts. */
export interface VaultPublicClient {
  readContract(args: {
    address: Address
    abi: Abi | readonly unknown[]
    functionName: string
    args?: readonly unknown[]
  }): Promise<unknown>
  /** Native ETH balance, used only to detect the no-gas case before a write. */
  getBalance(args: { address: Address }): Promise<bigint>
  waitForTransactionReceipt(args: { hash: Hex }): Promise<VaultReceipt>
}

/**
 * Write side of the chain.
 *
 * Note what is absent: `signMessage`, `signTypedData`, `signTransaction`. The
 * session key signs transactions inside viem's transport and nothing else; there
 * is no code path from a tool handler to a raw signature.
 */
export interface VaultWalletClient {
  account: { address: Address }
  writeContract(args: {
    address: Address
    abi: Abi | readonly unknown[]
    functionName: string
    args?: readonly unknown[]
    account?: unknown
    chain?: unknown
  }): Promise<Hex>
}

/** Where the merchant-facing payment header is sent. See KTD-9. */
export interface FacilitatorConfig {
  /** Chain identifier echoed in the payment payload. */
  network: string
}

export interface GiwaCardMcpContext {
  /** Deployed `CardVault` proxy. */
  vaultAddress: Address
  /** The end user whose balance backs every card this server mints. */
  vaultOwner: Address
  /** Read client. Source of truth (not Flashblocks — KTD-5). */
  publicClient: VaultPublicClient
  /** Session-key wallet. In-policy mints and charges go out from here. */
  sessionClient: VaultWalletClient
  /**
   * Vault-owner wallet, when the process was configured with one.
   *
   * Only `cancel_card` uses it, because `CardVault.cancelCard` checks
   * `msg.sender == card.vaultOwner` and a session key is never the vault owner.
   * Absent by default: without it `cancel_card` returns `OWNER_ACTION_REQUIRED`
   * rather than silently escalating a session key's authority.
   */
  ownerClient?: VaultWalletClient | undefined
  /** The over-policy approval queue. */
  approvals: ApprovalClient
  /**
   * Merchants this server knows about, checked against the onchain allowlist by
   * `get_policy`. The allowlist itself is a mapping and cannot be enumerated.
   */
  knownMerchants?: readonly Address[] | undefined
  /** Free-text agent label recorded on approval requests, for the owner. */
  agentLabel?: string | undefined
  facilitator?: FacilitatorConfig | undefined
  /** Injected clock in epoch ms, so expiry maths is testable. */
  now?: (() => number) | undefined
}

/** Address of the session key this server signs with. */
export function sessionAddress(context: GiwaCardMcpContext): Address {
  return context.sessionClient.account.address
}

/** Current time in epoch seconds, honouring the injected clock. */
export function nowSeconds(context: GiwaCardMcpContext): bigint {
  const millis = context.now ? context.now() : Date.now()
  return BigInt(Math.floor(millis / 1000))
}

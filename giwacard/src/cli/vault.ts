import type { Address } from 'viem'

import {
  cardStatusName,
  cardVaultAbi,
  CardStatus,
  type CardStatusName,
  type VaultCard,
  type VaultSessionPolicy,
} from '../chain/cardVaultAbi.js'
import { gusdAbi } from '../chain/gusdAbi.js'
import { withCliRetry, type CliPublicClient } from './chain.js'

/**
 * The vault reads the CLI performs, in one place.
 *
 * `src/mcp/vault.ts` does the same job for the agent surface, and the two are
 * deliberately not shared: the MCP module's reads are all scoped to one session
 * key and funnel their failures into the *agent* taxonomy, while these are the
 * owner's whole-vault view and produce {@link CliError}s written for a person.
 * Merging them would mean one of the two surfaces getting error messages written
 * for the other's reader.
 */

/** The owner's three balance figures. */
export interface VaultBalances {
  /** Everything deposited and not yet withdrawn or spent. */
  balance: bigint
  /** Sum of the caps of still-active cards. Untouchable. */
  escrowed: bigint
  /** `balance - escrowed`: what a new card can be backed by. */
  available: bigint
}

/** One card, decoded and with its id and status name attached. */
export interface CardSummary {
  id: bigint
  card: VaultCard
  status: CardStatusName
}

/**
 * How far back {@link readActiveCards} scans.
 *
 * `CardVault` has no per-owner card index — ids are global and the only way to
 * find an owner's cards through the view functions is to walk `lastCardId`
 * downwards. A bounded walk keeps `giwacard status` to a predictable number of
 * RPC calls against a documented-as-throttled endpoint; the dashboard (U10) is
 * where full history belongs, built from event logs.
 */
export const CARD_SCAN_LIMIT = 40

/** Read `balanceOf`, `escrowedOf` and `availableBalanceOf` for one owner. */
export async function readVaultBalances(
  publicClient: CliPublicClient,
  vault: Address,
  owner: Address,
): Promise<VaultBalances> {
  return withCliRetry(
    async () => {
      const [balance, escrowed, available] = await Promise.all([
        publicClient.readContract({
          address: vault,
          abi: cardVaultAbi,
          functionName: 'balanceOf',
          args: [owner],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: vault,
          abi: cardVaultAbi,
          functionName: 'escrowedOf',
          args: [owner],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: vault,
          abi: cardVaultAbi,
          functionName: 'availableBalanceOf',
          args: [owner],
        }) as Promise<bigint>,
      ])
      return { balance, escrowed, available }
    },
    { label: 'read your vault balance' },
  )
}

/** Read one card by id. A never-minted id comes back with status `none`. */
export async function readCard(
  publicClient: CliPublicClient,
  vault: Address,
  cardId: bigint,
): Promise<CardSummary> {
  const card = await withCliRetry(
    () =>
      publicClient.readContract({
        address: vault,
        abi: cardVaultAbi,
        functionName: 'getCard',
        args: [cardId],
      }) as Promise<VaultCard>,
    { label: `read card ${cardId}` },
  )
  return { id: cardId, card, status: cardStatusName(card.status) }
}

/**
 * Find the owner's still-active cards.
 *
 * Walks `lastCardId` down for at most {@link CARD_SCAN_LIMIT} ids. The bound is
 * reported back so `status` can say "showing the most recent N" instead of
 * implying it found everything — a status screen that quietly truncates is worse
 * than one that admits it.
 */
export async function readActiveCards(
  publicClient: CliPublicClient,
  vault: Address,
  owner: Address,
  options: { limit?: number } = {},
): Promise<{ cards: CardSummary[]; scanned: number; truncated: boolean }> {
  const limit = options.limit ?? CARD_SCAN_LIMIT
  const last = await withCliRetry(
    () =>
      publicClient.readContract({
        address: vault,
        abi: cardVaultAbi,
        functionName: 'lastCardId',
      }) as Promise<bigint>,
    { label: 'read the vault card index' },
  )

  const cards: CardSummary[] = []
  let scanned = 0
  for (let id = last; id > 0n && scanned < limit; id--) {
    scanned++
    const summary = await readCard(publicClient, vault, id)
    if (summary.card.status !== CardStatus.Active) continue
    if (summary.card.vaultOwner.toLowerCase() !== owner.toLowerCase()) continue
    cards.push(summary)
  }

  return {
    cards,
    scanned,
    truncated: last > BigInt(scanned),
  }
}

/** Read a session key's onchain policy. */
export async function readSessionPolicy(
  publicClient: CliPublicClient,
  vault: Address,
  owner: Address,
  sessionKey: Address,
): Promise<VaultSessionPolicy> {
  return withCliRetry(
    () =>
      publicClient.readContract({
        address: vault,
        abi: cardVaultAbi,
        functionName: 'sessionPolicy',
        args: [owner, sessionKey],
      }) as Promise<VaultSessionPolicy>,
    { label: 'read the session key policy' },
  )
}

/** Read the ERC-20 this vault settles in. */
export async function readPaymentToken(
  publicClient: CliPublicClient,
  vault: Address,
): Promise<Address> {
  return withCliRetry(
    () =>
      publicClient.readContract({
        address: vault,
        abi: cardVaultAbi,
        functionName: 'paymentToken',
      }) as Promise<Address>,
    { label: 'read the vault payment token' },
  )
}

/** Read a gUSD balance. */
export async function readTokenBalance(
  publicClient: CliPublicClient,
  token: Address,
  account: Address,
): Promise<bigint> {
  return withCliRetry(
    () =>
      publicClient.readContract({
        address: token,
        abi: gusdAbi,
        functionName: 'balanceOf',
        args: [account],
      }) as Promise<bigint>,
    { label: 'read your gUSD balance' },
  )
}

/**
 * Read how much of `owner`'s gUSD `spender` is currently allowed to pull.
 *
 * `giwacard deposit` reads this to decide whether it owes an `approve` before
 * the deposit itself. A standing allowance from an earlier top-up makes the
 * second transaction unnecessary, and re-approving costs gas to change nothing.
 */
export async function readTokenAllowance(
  publicClient: CliPublicClient,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint> {
  return withCliRetry(
    () =>
      publicClient.readContract({
        address: token,
        abi: gusdAbi,
        functionName: 'allowance',
        args: [owner, spender],
      }) as Promise<bigint>,
    { label: 'read the vault gUSD allowance' },
  )
}

/**
 * Read the earliest second at which `account` may claim from the gUSD faucet.
 *
 * `0` means "never claimed, may claim now" — see `GUSD.faucetAvailableAt`.
 */
export async function readFaucetAvailableAt(
  publicClient: CliPublicClient,
  token: Address,
  account: Address,
): Promise<bigint> {
  return withCliRetry(
    () =>
      publicClient.readContract({
        address: token,
        abi: gusdAbi,
        functionName: 'faucetAvailableAt',
        args: [account],
      }) as Promise<bigint>,
    { label: 'check the gUSD faucet cooldown' },
  )
}

/** Whether a merchant is on a session key's allowlist. */
export async function isMerchantAllowed(
  publicClient: CliPublicClient,
  vault: Address,
  owner: Address,
  sessionKey: Address,
  merchant: Address,
): Promise<boolean> {
  return withCliRetry(
    () =>
      publicClient.readContract({
        address: vault,
        abi: cardVaultAbi,
        functionName: 'isMerchantAllowed',
        args: [owner, sessionKey, merchant],
      }) as Promise<boolean>,
    { label: 'check the merchant allowlist' },
  )
}

"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import {
  CARD_CANCELLED_EVENT,
  CARD_CHARGED_EVENT,
  CARD_EXPIRED_RELEASED_EVENT,
  CARD_MINTED_EVENT,
  cardVaultAbi,
  type VaultCard,
} from "@/lib/vault/abi";
import { computeBalance, type VaultBalance } from "@/lib/vault/balance";
import { deriveCardState, sortCards, type CardView } from "@/lib/vault/cards";
import { CARD_VAULT_ADDRESS, logFromBlock } from "@/lib/vault/config";
import {
  cardIdsFromMintLogs,
  historyFromLogs,
  type HistoryEntry,
} from "@/lib/vault/history";

/**
 * Onchain reads for the dashboard.
 *
 * Everything here is a *read* of vault state — onchain is truth (KTD-5), so
 * nothing is cached across sessions and nothing is optimistically written into
 * a local store. A refetch interval rather than a websocket subscription: the
 * public GIWA RPC is documented as rate-limited and dev-only, and a 15s poll on
 * four log queries is well inside what it tolerates.
 */

/** How often the vault is re-read, in ms. */
const POLL_INTERVAL_MS = 15_000;

/**
 * Most recent cards to resolve to full records.
 *
 * Card ids come from mint logs, but their *current* status has to come from
 * `getCard` — a log cannot tell you the card was later charged. Capping the
 * batch keeps one render from firing an unbounded multicall.
 */
export const MAX_CARDS_RESOLVED = 60;

export interface AsyncState {
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

/* -------------------------------------------------------------------------- */
/* Balance                                                                    */
/* -------------------------------------------------------------------------- */

export interface VaultSummary extends AsyncState {
  balance: VaultBalance | null;
  paymentToken: `0x${string}` | null;
}

export function useVaultSummary(): VaultSummary {
  const { address } = useAccount();
  const enabled = CARD_VAULT_ADDRESS !== null && address !== undefined;

  const { data, isLoading, isError, error, refetch } = useReadContracts({
    allowFailure: false,
    contracts: [
      {
        address: CARD_VAULT_ADDRESS ?? undefined,
        abi: cardVaultAbi,
        functionName: "balanceOf",
        args: address ? [address] : undefined,
      },
      {
        address: CARD_VAULT_ADDRESS ?? undefined,
        abi: cardVaultAbi,
        functionName: "escrowedOf",
        args: address ? [address] : undefined,
      },
      {
        address: CARD_VAULT_ADDRESS ?? undefined,
        abi: cardVaultAbi,
        functionName: "paymentToken",
      },
    ],
    query: { enabled, refetchInterval: POLL_INTERVAL_MS },
  });

  const [total, escrowed, token] = data ?? [];

  return {
    balance:
      total !== undefined && escrowed !== undefined
        ? computeBalance(total, escrowed)
        : null,
    paymentToken: token ?? null,
    isLoading: enabled && isLoading,
    isError,
    error: (error as Error | null) ?? null,
    refetch: () => void refetch(),
  };
}

/* -------------------------------------------------------------------------- */
/* Logs                                                                       */
/* -------------------------------------------------------------------------- */

export interface VaultActivity extends AsyncState {
  history: HistoryEntry[];
  cardIds: bigint[];
  /** Head of the chain at the time of the read, for the "as of" line. */
  latestBlock: bigint | null;
}

export function useVaultActivity(): VaultActivity {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const enabled =
    CARD_VAULT_ADDRESS !== null &&
    address !== undefined &&
    publicClient !== undefined;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["vault-activity", CARD_VAULT_ADDRESS, address],
    enabled,
    refetchInterval: POLL_INTERVAL_MS,
    queryFn: async () => {
      // `enabled` guarantees these, but the queryFn is typed independently.
      if (!publicClient || !address || !CARD_VAULT_ADDRESS) {
        throw new Error("Vault activity queried before it was ready.");
      }
      const latestBlock = await publicClient.getBlockNumber();
      const fromBlock = logFromBlock(latestBlock);
      const common = {
        address: CARD_VAULT_ADDRESS,
        args: { vaultOwner: address },
        fromBlock,
        toBlock: latestBlock,
      } as const;

      const [minted, charged, cancelled, expired] = await Promise.all([
        publicClient.getLogs({ ...common, event: CARD_MINTED_EVENT }),
        publicClient.getLogs({ ...common, event: CARD_CHARGED_EVENT }),
        publicClient.getLogs({ ...common, event: CARD_CANCELLED_EVENT }),
        publicClient.getLogs({ ...common, event: CARD_EXPIRED_RELEASED_EVENT }),
      ]);

      return {
        history: historyFromLogs({ minted, charged, cancelled, expired }),
        cardIds: cardIdsFromMintLogs(minted),
        latestBlock,
      };
    },
  });

  return {
    history: data?.history ?? [],
    cardIds: data?.cardIds ?? [],
    latestBlock: data?.latestBlock ?? null,
    isLoading: enabled && isLoading,
    isError,
    error: (error as Error | null) ?? null,
    refetch: () => void refetch(),
  };
}

/* -------------------------------------------------------------------------- */
/* Cards                                                                      */
/* -------------------------------------------------------------------------- */

export interface VaultCards extends AsyncState {
  cards: CardView[];
  /** True when older cards exist beyond {@link MAX_CARDS_RESOLVED}. */
  truncated: boolean;
}

export function useVaultCards(
  cardIds: readonly bigint[],
  nowSeconds: number,
): VaultCards {
  const ids = cardIds.slice(0, MAX_CARDS_RESOLVED);
  const enabled = CARD_VAULT_ADDRESS !== null && ids.length > 0;

  const { data, isLoading, isError, error, refetch } = useReadContracts({
    allowFailure: false,
    contracts: ids.map((cardId) => ({
      address: CARD_VAULT_ADDRESS ?? undefined,
      abi: cardVaultAbi,
      functionName: "getCard" as const,
      args: [cardId] as const,
    })),
    query: { enabled, refetchInterval: POLL_INTERVAL_MS },
  });

  const cards = ((data ?? []) as readonly VaultCard[]).map((card, index) =>
    deriveCardState(ids[index] ?? 0n, card, nowSeconds),
  );

  return {
    cards: sortCards(cards),
    truncated: cardIds.length > ids.length,
    isLoading: enabled && isLoading,
    isError,
    error: (error as Error | null) ?? null,
    refetch: () => void refetch(),
  };
}

/* -------------------------------------------------------------------------- */
/* Finality                                                                   */
/* -------------------------------------------------------------------------- */

export interface FinalizedBlock {
  /** Highest finalized block, or null if the RPC will not say. */
  blockNumber: bigint | null;
  isLoading: boolean;
  /** True when neither `finalized` nor `safe` could be read. */
  unavailable: boolean;
}

/**
 * The finality horizon.
 *
 * `latest` is not usable for this: on a Flashblocks chain it can already
 * contain preconfirmed transactions. `finalized` is asked for first, `safe`
 * second, and if the RPC supports neither the hook reports `unavailable` and
 * every row stays pending — the dashboard would rather understate finality than
 * overstate it (KTD-5).
 */
export function useFinalizedBlock(): FinalizedBlock {
  const publicClient = usePublicClient();

  const { data, isLoading } = useQuery({
    queryKey: ["finalized-block", publicClient?.chain?.id ?? 0],
    enabled: publicClient !== undefined,
    refetchInterval: POLL_INTERVAL_MS,
    queryFn: async (): Promise<{ blockNumber: bigint | null }> => {
      if (!publicClient) return { blockNumber: null };
      for (const blockTag of ["finalized", "safe"] as const) {
        try {
          const block = await publicClient.getBlock({ blockTag });
          if (block.number !== null) return { blockNumber: block.number };
        } catch {
          // Fall through: some OP Stack RPCs answer only one of the two tags.
        }
      }
      return { blockNumber: null };
    },
  });

  return {
    blockNumber: data?.blockNumber ?? null,
    isLoading,
    unavailable: data !== undefined && data.blockNumber === null,
  };
}

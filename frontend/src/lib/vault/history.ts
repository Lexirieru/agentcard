/**
 * Transaction history, derived from vault event logs.
 *
 * There is no history store anywhere in this system — not in the contract, not
 * in the daemon. The four card lifecycle events *are* the ledger, so this module
 * turns them into rows. Anything a row shows must be reconstructible from a log;
 * if it isn't in the event, the owner does not get to see it here.
 */

export type HistoryKind = "minted" | "charged" | "cancelled" | "expired";

/**
 * The subset of a viem log this module needs.
 *
 * Kept structural rather than importing viem's `Log` so the mapping can be
 * tested with plain objects — no chain, no RPC, no fixtures of decoded ABI
 * generics. `blockNumber` is nullable because a log read from a pending block
 * has no block yet, which is exactly the case the finality badge exists for.
 */
export interface HistoryLog<TArgs> {
  args: Partial<TArgs>;
  blockNumber?: bigint | null;
  transactionHash?: `0x${string}` | null;
  logIndex?: number | null;
}

export interface MintedArgs {
  cardId: bigint;
  vaultOwner: `0x${string}`;
  agent: `0x${string}`;
  token: `0x${string}`;
  cap: bigint;
  merchantScope: `0x${string}`;
  expiry: bigint;
}

export interface ChargedArgs {
  cardId: bigint;
  vaultOwner: `0x${string}`;
  merchant: `0x${string}`;
  amount: bigint;
  released: bigint;
}

export interface CancelledArgs {
  cardId: bigint;
  vaultOwner: `0x${string}`;
  released: bigint;
}

export interface ExpiredArgs {
  cardId: bigint;
  vaultOwner: `0x${string}`;
  caller: `0x${string}`;
  released: bigint;
}

export interface HistoryEntry {
  /** Stable across refetches: a log is uniquely identified by tx + index. */
  id: string;
  kind: HistoryKind;
  cardId: bigint;
  /** The headline number of the row, in token base units. */
  amount: bigint;
  /** Escrow returned to available balance, when the event released any. */
  released: bigint | null;
  /** Signed effect on the owner's *total* balance. Only a charge moves it. */
  balanceDelta: bigint;
  /** Signed effect on escrow. Mint locks, everything else unlocks. */
  escrowDelta: bigint;
  /** Agent, merchant or reaper, depending on the event. Null when none applies. */
  counterparty: `0x${string}` | null;
  blockNumber: bigint | null;
  txHash: `0x${string}` | null;
  logIndex: number | null;
}

export interface HistoryLogs {
  minted?: readonly HistoryLog<MintedArgs>[];
  charged?: readonly HistoryLog<ChargedArgs>[];
  cancelled?: readonly HistoryLog<CancelledArgs>[];
  expired?: readonly HistoryLog<ExpiredArgs>[];
}

/** Human-readable verb per event, used as the row title. */
export const HISTORY_LABELS: Record<HistoryKind, string> = {
  minted: "Card minted",
  charged: "Card charged",
  cancelled: "Card cancelled",
  expired: "Escrow released",
};

/**
 * One line of plain English per row. Written out rather than templated in the
 * component so the wording is covered by the same tests as the numbers.
 */
export function describeEntry(entry: HistoryEntry): string {
  switch (entry.kind) {
    case "minted":
      return "Cap escrowed against the vault balance.";
    case "charged":
      return entry.released && entry.released > 0n
        ? "Merchant charged the card; the unspent remainder returned to available."
        : "Merchant charged the card for its full cap.";
    case "cancelled":
      return "You cancelled the card before it was charged; escrow returned to available.";
    case "expired":
      return "The card outlived its expiry and its escrow was reaped back to available.";
  }
}

function logId(log: HistoryLog<unknown>, kind: HistoryKind, cardId: bigint): string {
  const tx = log.transactionHash ?? "pending";
  const index = log.logIndex ?? "x";
  return `${tx}:${index}:${kind}:${cardId}`;
}

/**
 * Fold the four log streams into one ordered ledger, newest first.
 *
 * Logs missing a decoded `cardId` are dropped rather than rendered as a row
 * with a blank identity — a malformed log is a decode bug, and a row the owner
 * cannot act on is worse than one fewer row.
 */
export function historyFromLogs(logs: HistoryLogs): HistoryEntry[] {
  const entries: HistoryEntry[] = [];

  for (const log of logs.minted ?? []) {
    const { cardId, cap } = log.args;
    if (cardId === undefined || cap === undefined) continue;
    entries.push({
      id: logId(log, "minted", cardId),
      kind: "minted",
      cardId,
      amount: cap,
      released: null,
      balanceDelta: 0n,
      escrowDelta: cap,
      counterparty: log.args.agent ?? null,
      blockNumber: log.blockNumber ?? null,
      txHash: log.transactionHash ?? null,
      logIndex: log.logIndex ?? null,
    });
  }

  for (const log of logs.charged ?? []) {
    const { cardId, amount, released } = log.args;
    if (cardId === undefined || amount === undefined) continue;
    const releasedAmount = released ?? 0n;
    entries.push({
      id: logId(log, "charged", cardId),
      kind: "charged",
      cardId,
      amount,
      released: releasedAmount,
      balanceDelta: -amount,
      // The whole cap leaves escrow: the spent part settles, the rest returns.
      escrowDelta: -(amount + releasedAmount),
      counterparty: log.args.merchant ?? null,
      blockNumber: log.blockNumber ?? null,
      txHash: log.transactionHash ?? null,
      logIndex: log.logIndex ?? null,
    });
  }

  for (const log of logs.cancelled ?? []) {
    const { cardId, released } = log.args;
    if (cardId === undefined || released === undefined) continue;
    entries.push({
      id: logId(log, "cancelled", cardId),
      kind: "cancelled",
      cardId,
      amount: released,
      released,
      balanceDelta: 0n,
      escrowDelta: -released,
      counterparty: null,
      blockNumber: log.blockNumber ?? null,
      txHash: log.transactionHash ?? null,
      logIndex: log.logIndex ?? null,
    });
  }

  for (const log of logs.expired ?? []) {
    const { cardId, released } = log.args;
    if (cardId === undefined || released === undefined) continue;
    entries.push({
      id: logId(log, "expired", cardId),
      kind: "expired",
      cardId,
      amount: released,
      released,
      balanceDelta: 0n,
      escrowDelta: -released,
      counterparty: log.args.caller ?? null,
      blockNumber: log.blockNumber ?? null,
      txHash: log.transactionHash ?? null,
      logIndex: log.logIndex ?? null,
    });
  }

  return sortHistory(entries);
}

/**
 * Newest first. An entry with no block number sorts above every mined one: it
 * is in flight, which by definition happened after everything already mined.
 */
export function sortHistory(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.blockNumber === null && b.blockNumber === null) return 0;
    if (a.blockNumber === null) return -1;
    if (b.blockNumber === null) return 1;
    if (a.blockNumber !== b.blockNumber) {
      return a.blockNumber > b.blockNumber ? -1 : 1;
    }
    return (b.logIndex ?? 0) - (a.logIndex ?? 0);
  });
}

/** Card ids seen in mint logs, newest first — the owner's card list. */
export function cardIdsFromMintLogs(
  minted: readonly HistoryLog<MintedArgs>[],
): bigint[] {
  const seen = new Set<string>();
  const ids: bigint[] = [];
  for (const log of minted) {
    const { cardId } = log.args;
    if (cardId === undefined) continue;
    const key = cardId.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(cardId);
  }
  return ids.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
}

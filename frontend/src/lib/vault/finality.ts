import type { BadgeTone } from "@/components/ui";

/**
 * Finality (KTD-5).
 *
 * GIWA is an OP Stack chain with Flashblocks: a transaction gets a
 * preconfirmation in ~200ms, and the `latest` block tag can already include it.
 * A preconfirmation is a *UX affordance* — a promise by the sequencer — not
 * consensus. This dashboard therefore never derives "settled" from `latest`;
 * only a block at or below the `finalized` tag counts.
 *
 * The failure direction is chosen deliberately: if the RPC cannot answer for
 * `finalized` at all, everything reads `pending`. Showing a settled transaction
 * as pending costs the owner a refresh; showing a preconfirmed one as settled
 * could cost them the assumption that money has actually moved.
 */
export type Finality = "pending" | "settled";

export function deriveFinality(
  blockNumber: bigint | null | undefined,
  finalizedBlockNumber: bigint | null | undefined,
): Finality {
  // No block yet: still in the mempool, or preconfirmed but unmined.
  if (blockNumber === null || blockNumber === undefined) return "pending";
  if (finalizedBlockNumber === null || finalizedBlockNumber === undefined) {
    return "pending";
  }
  return blockNumber <= finalizedBlockNumber ? "settled" : "pending";
}

export function finalityLabel(finality: Finality): string {
  return finality === "settled" ? "Settled" : "Pending";
}

export function finalityTone(finality: Finality): BadgeTone {
  return finality === "settled" ? "settled" : "pending";
}

/** Hover copy that says *why* a row is still pending, without hedging. */
export function finalityHint(
  finality: Finality,
  finalizedBlockNumber: bigint | null | undefined,
): string {
  if (finality === "settled") {
    return "Included in a finalized block. This is onchain truth.";
  }
  if (finalizedBlockNumber === null || finalizedBlockNumber === undefined) {
    return "The RPC has not reported a finalized block, so nothing can be shown as settled yet.";
  }
  return "Preconfirmed or recently mined, but not yet finalized. Not final until it is.";
}

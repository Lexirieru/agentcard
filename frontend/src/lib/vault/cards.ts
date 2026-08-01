import type { BadgeTone } from "@/components/ui";
import { CardStatus, type VaultCard } from "./abi";

/**
 * Card state as the owner should read it.
 *
 * The onchain `status` is the source of truth, with one honest complication:
 * escrow release at expiry is permissionless, so a card whose `expiry` has
 * passed still reads `Active` until somebody calls `releaseExpired`. The owner
 * must see that as expired-but-unreaped, not as a live card — the escrow is
 * still locked, but nothing can be charged against it any more.
 */
export type CardState =
  | "active"
  | "expiring"
  | "expired-unreaped"
  | "used"
  | "expired"
  | "revoked"
  | "unknown";

export interface CardView {
  cardId: bigint;
  card: VaultCard;
  state: CardState;
  label: string;
  tone: BadgeTone;
  /** True while escrow is still locked against this card. */
  escrowLocked: boolean;
  /** True when the owner can still cancel it and recover the escrow. */
  cancellable: boolean;
  /** Unix seconds. */
  expiry: number;
}

/** Window in which an active card is called out as about to expire. */
export const EXPIRING_SOON_SECONDS = 60 * 60;

const LABELS: Record<CardState, string> = {
  active: "Active",
  expiring: "Expiring soon",
  "expired-unreaped": "Expired",
  expired: "Expired",
  used: "Used",
  revoked: "Revoked",
  unknown: "Unknown",
};

const TONES: Record<CardState, BadgeTone> = {
  active: "settled",
  expiring: "pending",
  "expired-unreaped": "expired",
  expired: "expired",
  used: "neutral",
  revoked: "danger",
  unknown: "neutral",
};

/**
 * Derive the owner-facing state of one card.
 *
 * @param nowSeconds Unix seconds, injected so this stays pure and testable.
 */
export function deriveCardState(
  cardId: bigint,
  card: VaultCard,
  nowSeconds: number,
): CardView {
  const expiry = Number(card.expiry);
  const state = classify(card, nowSeconds, expiry);

  return {
    cardId,
    card,
    state,
    label: LABELS[state],
    tone: TONES[state],
    escrowLocked: card.status === CardStatus.Active,
    cancellable: state === "active" || state === "expiring",
    expiry,
  };
}

function classify(
  card: VaultCard,
  nowSeconds: number,
  expiry: number,
): CardState {
  switch (card.status) {
    case CardStatus.Active:
      if (nowSeconds > expiry) return "expired-unreaped";
      if (expiry - nowSeconds <= EXPIRING_SOON_SECONDS) return "expiring";
      return "active";
    case CardStatus.Used:
      return "used";
    case CardStatus.Expired:
      return "expired";
    case CardStatus.Revoked:
      return "revoked";
    default:
      // Includes `None`: an id that was never minted, which should be
      // unreachable here since ids come from CardMinted logs.
      return "unknown";
  }
}

/** Filters the card list offers, in the order they appear as tabs. */
export const CARD_FILTERS = ["all", "active", "used", "expired", "revoked"] as const;
export type CardFilter = (typeof CARD_FILTERS)[number];

export function matchesFilter(view: CardView, filter: CardFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return view.state === "active" || view.state === "expiring";
    case "used":
      return view.state === "used";
    case "expired":
      return view.state === "expired" || view.state === "expired-unreaped";
    case "revoked":
      return view.state === "revoked";
  }
}

/** Newest first. Card ids are monotonic, so id order *is* mint order. */
export function sortCards(views: readonly CardView[]): CardView[] {
  return [...views].sort((a, b) => (a.cardId > b.cardId ? -1 : a.cardId < b.cardId ? 1 : 0));
}

export function countByFilter(
  views: readonly CardView[],
  filter: CardFilter,
): number {
  return views.reduce((total, view) => (matchesFilter(view, filter) ? total + 1 : total), 0);
}

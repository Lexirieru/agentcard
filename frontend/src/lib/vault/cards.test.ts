import { describe, expect, test } from "bun:test";
import { CardStatus, type VaultCard } from "./abi";
import {
  countByFilter,
  deriveCardState,
  matchesFilter,
  sortCards,
  type CardFilter,
} from "./cards";

const NOW = 1_800_000_000;

function card(overrides: Partial<VaultCard> = {}): VaultCard {
  return {
    vaultOwner: "0x1111111111111111111111111111111111111111",
    agent: "0x2222222222222222222222222222222222222222",
    token: "0x3333333333333333333333333333333333333333",
    cap: 1_000_000n,
    merchantScope: "0x4444444444444444444444444444444444444444",
    expiry: BigInt(NOW + 86_400),
    status: CardStatus.Active,
    ...overrides,
  };
}

describe("deriveCardState", () => {
  test("an active card with time left is active and cancellable", () => {
    const view = deriveCardState(1n, card(), NOW);
    expect(view.state).toBe("active");
    expect(view.label).toBe("Active");
    expect(view.tone).toBe("settled");
    expect(view.escrowLocked).toBe(true);
    expect(view.cancellable).toBe(true);
  });

  test("an active card inside the hour before expiry is flagged", () => {
    const view = deriveCardState(1n, card({ expiry: BigInt(NOW + 600) }), NOW);
    expect(view.state).toBe("expiring");
    expect(view.tone).toBe("pending");
    expect(view.cancellable).toBe(true);
  });

  test("an Active card past its expiry reads expired, not active", () => {
    // releaseExpired is permissionless, so nothing has flipped the status yet —
    // but the card can no longer be charged and must not look live.
    const view = deriveCardState(7n, card({ expiry: BigInt(NOW - 1) }), NOW);
    expect(view.state).toBe("expired-unreaped");
    expect(view.label).toBe("Expired");
    expect(view.tone).toBe("expired");
    expect(view.cancellable).toBe(false);
    // Escrow is still locked until somebody reaps it.
    expect(view.escrowLocked).toBe(true);
  });

  test("terminal statuses map onto their own tones", () => {
    expect(deriveCardState(1n, card({ status: CardStatus.Used }), NOW).tone).toBe(
      "neutral",
    );
    expect(
      deriveCardState(1n, card({ status: CardStatus.Expired }), NOW).state,
    ).toBe("expired");
    expect(
      deriveCardState(1n, card({ status: CardStatus.Revoked }), NOW).tone,
    ).toBe("danger");
  });

  test("a status outside the enum degrades instead of throwing", () => {
    const view = deriveCardState(1n, card({ status: 99 }), NOW);
    expect(view.state).toBe("unknown");
    expect(view.escrowLocked).toBe(false);
  });

  test("a never-minted id reads unknown, never active", () => {
    const view = deriveCardState(0n, card({ status: CardStatus.None }), NOW);
    expect(view.state).toBe("unknown");
  });
});

describe("filters", () => {
  const views = [
    deriveCardState(1n, card(), NOW),
    deriveCardState(2n, card({ expiry: BigInt(NOW + 600) }), NOW),
    deriveCardState(3n, card({ status: CardStatus.Used }), NOW),
    deriveCardState(4n, card({ status: CardStatus.Expired }), NOW),
    deriveCardState(5n, card({ expiry: BigInt(NOW - 10) }), NOW),
    deriveCardState(6n, card({ status: CardStatus.Revoked }), NOW),
  ];

  test("active covers both active and expiring-soon", () => {
    expect(countByFilter(views, "active")).toBe(2);
  });

  test("expired covers reaped and not-yet-reaped alike", () => {
    expect(countByFilter(views, "expired")).toBe(2);
  });

  test("all matches everything", () => {
    expect(countByFilter(views, "all")).toBe(views.length);
  });

  test("every filter is exhaustive", () => {
    const filters: CardFilter[] = ["all", "active", "used", "expired", "revoked"];
    for (const filter of filters) {
      expect(typeof matchesFilter(views[0]!, filter)).toBe("boolean");
    }
  });
});

describe("sortCards", () => {
  test("newest card id first", () => {
    const sorted = sortCards([
      deriveCardState(2n, card(), NOW),
      deriveCardState(10n, card(), NOW),
      deriveCardState(1n, card(), NOW),
    ]);
    expect(sorted.map((view) => view.cardId)).toEqual([10n, 2n, 1n]);
  });

  test("does not mutate its input", () => {
    const input = [deriveCardState(1n, card(), NOW), deriveCardState(2n, card(), NOW)];
    sortCards(input);
    expect(input.map((view) => view.cardId)).toEqual([1n, 2n]);
  });
});

"use client";

import { useState } from "react";
import { Badge, cx, Panel } from "@/components/ui";
import type { VaultCards } from "@/hooks/use-vault";
import {
  absoluteTime,
  formatUnitsFixed,
  isZeroAddress,
  relativeTime,
  shortAddress,
} from "@/lib/format";
import {
  CARD_FILTERS,
  countByFilter,
  matchesFilter,
  type CardFilter,
  type CardView,
} from "@/lib/vault/cards";
import {
  CARD_VAULT_ADDRESS,
  PAYMENT_TOKEN_DECIMALS,
  PAYMENT_TOKEN_SYMBOL,
} from "@/lib/vault/config";
import { Caption, EmptyState, ErrorState, SkeletonRows } from "./states";

const FILTER_LABELS: Record<CardFilter, string> = {
  all: "All",
  active: "Active",
  used: "Used",
  expired: "Expired",
  revoked: "Revoked",
};

/**
 * The card list (R12).
 *
 * The finality badge here is the card's *lifecycle* state, read straight from
 * `getCard`. That is deliberately not the same axis as a transaction's
 * finality: a card is Active or it is not, and the contract is the only thing
 * that decides. Transaction finality lives on the history rows.
 */
export function CardsPanel({
  cards,
  nowMs,
  clockReady,
}: {
  cards: VaultCards;
  nowMs: number;
  clockReady: boolean;
}) {
  const [filter, setFilter] = useState<CardFilter>("all");

  if (CARD_VAULT_ADDRESS === null) {
    return (
      <Panel title="Cards">
        <ErrorState
          title="No vault address configured"
          body="Set NEXT_PUBLIC_CARD_VAULT_ADDRESS to read cards from the vault."
        />
      </Panel>
    );
  }

  const visible = cards.cards.filter((card) => matchesFilter(card, filter));

  return (
    <Panel title="Cards">
      {/* Five filters do not fit a phone in one line, so the strip scrolls
          inside its own track rather than widening the page. */}
      <div className="mb-5 flex w-full items-center gap-1 overflow-x-auto rounded-full border border-ink/10 bg-ink/5 p-1 backdrop-blur">
        {CARD_FILTERS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setFilter(option)}
            className={cx(
              "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
              filter === option
                ? "bg-ink text-white"
                : "text-ink/60 hover:text-ink",
            )}
            aria-pressed={filter === option}
          >
            {FILTER_LABELS[option]}
            <span className="ml-1.5 text-[10px] opacity-60">
              {countByFilter(cards.cards, option)}
            </span>
          </button>
        ))}
      </div>

      <CardsBody
        cards={cards}
        visible={visible}
        filter={filter}
        nowMs={nowMs}
        clockReady={clockReady}
      />
      {cards.truncated ? (
        <Caption className="mt-4">
          Showing the most recent cards only. Older ones are still onchain.
        </Caption>
      ) : null}
    </Panel>
  );
}

function CardsBody({
  cards,
  visible,
  filter,
  nowMs,
  clockReady,
}: {
  cards: VaultCards;
  visible: CardView[];
  filter: CardFilter;
  nowMs: number;
  clockReady: boolean;
}) {
  if (cards.isLoading || !clockReady) return <SkeletonRows count={3} />;

  if (cards.isError) {
    return (
      <ErrorState
        title="Could not read your cards"
        body={
          cards.error?.message ??
          "The RPC did not return card records. It may be rate limiting this page."
        }
        onRetry={cards.refetch}
      />
    );
  }

  if (cards.cards.length === 0) {
    return (
      <EmptyState
        title="No cards yet"
        body="When an agent mints a card against your vault, it appears here with its cap, merchant scope and lifecycle state."
      />
    );
  }

  if (visible.length === 0) {
    return (
      <EmptyState
        title={`No ${FILTER_LABELS[filter].toLowerCase()} cards`}
        body="Nothing matches this filter right now. Switch to All to see every card the vault has minted for you."
      />
    );
  }

  return (
    <ul className="divide-y divide-ink/10">
      {visible.map((card) => (
        <CardRow
          key={card.cardId.toString()}
          card={card}
          nowMs={nowMs}
          clockReady={clockReady}
        />
      ))}
    </ul>
  );
}

function CardRow({
  card,
  nowMs,
  clockReady,
}: {
  card: CardView;
  nowMs: number;
  clockReady: boolean;
}) {
  const openScope = isZeroAddress(card.card.merchantScope);

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-ink">
            Card #{card.cardId.toString()}
          </span>
          <Badge tone={card.tone}>{card.label}</Badge>
          {card.state === "expired-unreaped" ? (
            <span className="text-[11px] text-ink/50">
              escrow still locked until reaped
            </span>
          ) : null}
        </div>
        <p className="mt-1.5 truncate text-xs text-ink/55">
          {openScope ? (
            <span className="text-amber-800">Any merchant</span>
          ) : (
            <span title={card.card.merchantScope} className="font-mono">
              {shortAddress(card.card.merchantScope)}
            </span>
          )}
          <span className="px-1.5 text-ink/25">·</span>
          agent{" "}
          <span title={card.card.agent} className="font-mono">
            {shortAddress(card.card.agent)}
          </span>
        </p>
      </div>

      <div className="shrink-0 text-right">
        <p className="text-lg font-light tracking-tight text-ink">
          {formatUnitsFixed(card.card.cap, PAYMENT_TOKEN_DECIMALS)}
          <span className="ml-1 text-xs text-ink/40">
            {PAYMENT_TOKEN_SYMBOL}
          </span>
        </p>
        <p
          className="mt-0.5 text-[11px] text-ink/45"
          title={absoluteTime(card.expiry * 1000)}
        >
          {clockReady
            ? `expires ${relativeTime(card.expiry * 1000, nowMs)}`
            : "expiry —"}
        </p>
      </div>
    </li>
  );
}

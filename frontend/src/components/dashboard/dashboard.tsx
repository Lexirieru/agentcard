"use client";

import { useAppKit } from "@reown/appkit/react";
import { useAccount } from "wagmi";
import { Button, Stagger } from "@/components/ui";
import { giwaSepolia } from "@/config/networks";
import {
  useFinalizedBlock,
  useVaultActivity,
  useVaultCards,
  useVaultSummary,
} from "@/hooks/use-vault";
import { useNow } from "@/hooks/use-now";
import { shortAddress } from "@/lib/format";
import { ApprovalsPanel } from "./approvals-panel";
import { BalancePanel } from "./balance-panel";
import { CardsPanel } from "./cards-panel";
import { ConnectPrompt } from "./connect-prompt";
import { HistoryPanel } from "./history-panel";
import { SiteHeader } from "./site-header";

/**
 * The owner's surface: approval queue, cards, balance, history (R11–R13).
 *
 * One page rather than four routes. These four things are read together — an
 * approval is judged against the available balance, and a card's fate is read
 * off the history — so splitting them across navigation would make the owner
 * hold state in their head that the screen could just show.
 */
export function Dashboard() {
  const { address, isConnected, chainId } = useAccount();
  const { open } = useAppKit();
  const { nowMs, ready } = useNow();

  const summary = useVaultSummary();
  const activity = useVaultActivity();
  const cards = useVaultCards(activity.cardIds, Math.floor(nowMs / 1000));
  const finalized = useFinalizedBlock();

  const wrongNetwork = isConnected && chainId !== giwaSepolia.id;

  return (
    <div className="mx-auto w-full max-w-5xl px-5 pb-24 sm:px-8">
      <SiteHeader />

      {!isConnected ? (
        <ConnectPrompt />
      ) : (
        <div className="space-y-5">
          <Stagger>
            <div className="pb-2 pt-4">
              <h1
                className="font-light tracking-tight text-ink"
                style={{
                  fontSize: "clamp(2rem, 5.5vw, 3.5rem)",
                  lineHeight: 1.05,
                }}
              >
                Your vault
              </h1>
              <p className="mt-3 break-all font-mono text-xs text-ink/50">
                {address}
              </p>
            </div>
          </Stagger>

          {wrongNetwork ? (
            <Stagger delay={0.05}>
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-600/25 bg-amber-500/10 px-5 py-4"
              >
                <p className="text-sm leading-relaxed text-amber-900">
                  {shortAddress(address)} is connected to another network.
                  Everything below reads {giwaSepolia.name}, so it will stay
                  empty until you switch.
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void open({ view: "Networks" })}
                >
                  Switch network
                </Button>
              </div>
            </Stagger>
          ) : null}

          <Stagger delay={0.1}>
            <BalancePanel summary={summary} />
          </Stagger>

          <Stagger delay={0.2}>
            <ApprovalsPanel
              ownerAddress={address ?? null}
              paymentToken={summary.paymentToken}
              nowMs={nowMs}
              clockReady={ready}
            />
          </Stagger>

          <Stagger delay={0.3}>
            <CardsPanel cards={cards} nowMs={nowMs} clockReady={ready} />
          </Stagger>

          <Stagger delay={0.4}>
            <HistoryPanel activity={activity} finalized={finalized} />
          </Stagger>
        </div>
      )}
    </div>
  );
}

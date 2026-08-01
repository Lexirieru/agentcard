"use client";

import { Badge, Panel } from "@/components/ui";
import type { FinalizedBlock, VaultActivity } from "@/hooks/use-vault";
import { formatUnitsFixed, shortAddress } from "@/lib/format";
import {
  CARD_VAULT_ADDRESS,
  EXPLORER_URL,
  PAYMENT_TOKEN_DECIMALS,
  PAYMENT_TOKEN_SYMBOL,
} from "@/lib/vault/config";
import {
  deriveFinality,
  finalityHint,
  finalityLabel,
  finalityTone,
} from "@/lib/vault/finality";
import {
  describeEntry,
  HISTORY_LABELS,
  type HistoryEntry,
} from "@/lib/vault/history";
import { Caption, EmptyState, ErrorState, SkeletonRows } from "./states";

/**
 * Transaction history (R13), rebuilt from vault logs.
 *
 * Each row carries a finality badge derived from the finalized block height,
 * never from `latest`. On a Flashblocks chain `latest` can already contain a
 * preconfirmed transaction, and a preconfirmation is a promise, not
 * settlement (KTD-5).
 */
export function HistoryPanel({
  activity,
  finalized,
}: {
  activity: VaultActivity;
  finalized: FinalizedBlock;
}) {
  if (CARD_VAULT_ADDRESS === null) {
    return (
      <Panel title="Activity">
        <ErrorState
          title="No vault address configured"
          body="History is derived from CardVault event logs, so there is nothing to read until NEXT_PUBLIC_CARD_VAULT_ADDRESS is set."
        />
      </Panel>
    );
  }

  return (
    <Panel
      title="Activity"
      action={
        <Caption className="text-right">
          {finalized.unavailable
            ? "finality unknown"
            : finalized.blockNumber !== null
              ? `finalized #${finalized.blockNumber.toString()}`
              : "reading finality…"}
        </Caption>
      }
    >
      {finalized.unavailable ? (
        <p className="mb-4 rounded-xl bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-900">
          This RPC does not report a finalized block, so nothing below can be
          shown as settled. Everything stays pending rather than being presented
          as final on a preconfirmation.
        </p>
      ) : null}

      <HistoryBody activity={activity} finalized={finalized} />
    </Panel>
  );
}

function HistoryBody({
  activity,
  finalized,
}: {
  activity: VaultActivity;
  finalized: FinalizedBlock;
}) {
  if (activity.isLoading) return <SkeletonRows count={4} />;

  if (activity.isError) {
    return (
      <ErrorState
        title="Could not read the event log"
        body={
          activity.error?.message ??
          "The RPC refused the log query. Public GIWA Sepolia endpoints cap how far back eth_getLogs may reach."
        }
        onRetry={activity.refetch}
      />
    );
  }

  if (activity.history.length === 0) {
    return (
      <EmptyState
        title="Nothing has happened yet"
        body="Mints, charges, cancellations and expiry releases all show up here as soon as they hit the chain. There is no separate history store — this is the vault's own event log."
      />
    );
  }

  return (
    <ul className="divide-y divide-ink/10">
      {activity.history.map((entry) => (
        <HistoryRow
          key={entry.id}
          entry={entry}
          finalizedBlock={finalized.blockNumber}
        />
      ))}
    </ul>
  );
}

function HistoryRow({
  entry,
  finalizedBlock,
}: {
  entry: HistoryEntry;
  finalizedBlock: bigint | null;
}) {
  const finality = deriveFinality(entry.blockNumber, finalizedBlock);
  const spent = entry.balanceDelta < 0n;

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-ink">{HISTORY_LABELS[entry.kind]}</span>
          <span className="font-mono text-xs text-ink/45">
            #{entry.cardId.toString()}
          </span>
          <Badge
            tone={finalityTone(finality)}
            className="cursor-help"
          >
            <span title={finalityHint(finality, finalizedBlock)}>
              {finalityLabel(finality)}
            </span>
          </Badge>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-ink/55">
          {describeEntry(entry)}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink/40">
          {entry.counterparty ? (
            <span className="font-mono" title={entry.counterparty}>
              {shortAddress(entry.counterparty)}
            </span>
          ) : null}
          {entry.blockNumber !== null ? (
            <span>block {entry.blockNumber.toString()}</span>
          ) : (
            <span>not yet mined</span>
          )}
          {entry.txHash ? (
            <a
              className="underline decoration-ink/20 underline-offset-2 hover:text-ink/70"
              href={`${EXPLORER_URL}/tx/${entry.txHash}`}
              target="_blank"
              rel="noreferrer"
            >
              tx
            </a>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 text-right">
        <p
          className={
            spent
              ? "text-lg font-light tracking-tight text-ink"
              : "text-lg font-light tracking-tight text-ink/60"
          }
        >
          {spent ? "−" : ""}
          {formatUnitsFixed(entry.amount, PAYMENT_TOKEN_DECIMALS)}
          <span className="ml-1 text-xs text-ink/40">
            {PAYMENT_TOKEN_SYMBOL}
          </span>
        </p>
        {entry.released !== null && entry.released > 0n && entry.kind === "charged" ? (
          <p className="mt-0.5 text-[11px] text-ink/45">
            {formatUnitsFixed(entry.released, PAYMENT_TOKEN_DECIMALS)} returned
          </p>
        ) : null}
      </div>
    </li>
  );
}

"use client";

import { Panel } from "@/components/ui";
import { formatUnitsFixed } from "@/lib/format";
import { escrowedFraction } from "@/lib/vault/balance";
import {
  CARD_VAULT_ADDRESS,
  PAYMENT_TOKEN_DECIMALS,
  PAYMENT_TOKEN_SYMBOL,
} from "@/lib/vault/config";
import type { VaultSummary } from "@/hooks/use-vault";
import { Caption, ErrorState, SkeletonBlock } from "./states";

/**
 * Balance, escrow and available — the three numbers the whole product is about.
 *
 * `available` is computed here rather than read from `availableBalanceOf` so
 * that the arithmetic the owner is being shown is the arithmetic that was
 * tested. It is the same subtraction the contract performs.
 */
export function BalancePanel({ summary }: { summary: VaultSummary }) {
  if (CARD_VAULT_ADDRESS === null) {
    return (
      <Panel title="Balance">
        <ErrorState
          title="No vault address configured"
          body="Set NEXT_PUBLIC_CARD_VAULT_ADDRESS to the CardVault proxy on GIWA Sepolia and reload. Until then there is no vault to read."
        />
      </Panel>
    );
  }

  if (summary.isError) {
    return (
      <Panel title="Balance">
        <ErrorState
          title="Could not read the vault"
          body={
            summary.error?.message ??
            "The RPC did not answer. The public GIWA Sepolia endpoint is rate limited."
          }
          onRetry={summary.refetch}
        />
      </Panel>
    );
  }

  const balance = summary.balance;
  const loading = summary.isLoading || balance === null;
  const fraction = balance ? escrowedFraction(balance) : 0;

  return (
    <Panel
      title="Balance"
      action={
        <Caption className="text-right">
          {PAYMENT_TOKEN_SYMBOL} · onchain
        </Caption>
      }
    >
      <div className="grid gap-6 sm:grid-cols-3">
        <Stat
          label="Available"
          value={balance ? formatUnitsFixed(balance.available, PAYMENT_TOKEN_DECIMALS) : null}
          loading={loading}
          emphasis
          hint="Balance minus escrow. What can back a new card."
        />
        <Stat
          label="Escrowed"
          value={balance ? formatUnitsFixed(balance.escrowed, PAYMENT_TOKEN_DECIMALS) : null}
          loading={loading}
          hint="Locked behind active cards. Not spent yet."
        />
        <Stat
          label="Total"
          value={balance ? formatUnitsFixed(balance.total, PAYMENT_TOKEN_DECIMALS) : null}
          loading={loading}
          hint="Everything deposited and not withdrawn."
        />
      </div>

      <div className="mt-7">
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-ink/10"
          role="img"
          aria-label={
            balance
              ? `${Math.round(fraction * 100)} percent of the balance is escrowed`
              : "Balance not loaded"
          }
        >
          <div
            className="h-full rounded-full bg-ink/45 transition-[width] duration-500"
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        </div>
        <Caption className="mt-2">
          {balance
            ? `${Math.round(fraction * 100)}% of your balance is locked in active card escrow.`
            : "Reading escrow…"}
        </Caption>
      </div>
    </Panel>
  );
}

function Stat({
  label,
  value,
  loading,
  hint,
  emphasis,
}: {
  label: string;
  value: string | null;
  loading: boolean;
  hint: string;
  emphasis?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-wide text-ink/45">{label}</p>
      {loading || value === null ? (
        <SkeletonBlock className="mt-3 h-9 w-32 rounded-lg" />
      ) : (
        <p
          className={
            emphasis
              ? "mt-2 truncate text-4xl font-light tracking-tight text-ink"
              : "mt-2 truncate text-4xl font-light tracking-tight text-ink/70"
          }
          title={`${value} ${PAYMENT_TOKEN_SYMBOL}`}
        >
          {value}
        </p>
      )}
      <Caption className="mt-2">{hint}</Caption>
    </div>
  );
}

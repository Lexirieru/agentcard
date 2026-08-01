"use client";

import { useState } from "react";
import type { Address } from "viem";
import { Badge, Button, cx, Panel } from "@/components/ui";
import { formatUnitsFixed, shortAddress } from "@/lib/format";
import {
  PAYMENT_TOKEN_DECIMALS,
  PAYMENT_TOKEN_SYMBOL,
} from "@/lib/vault/config";
import type { SessionKeyView } from "@/lib/vault/session-keys";
import { Caption, EmptyState, ErrorState, SkeletonRows } from "./states";

/**
 * The owner's session keys, and the controls that govern them.
 *
 * This panel exists because the product's premise is that the owner sets the
 * limits, and until now those limits could only be set from the CLI wizard.
 * Revoking in particular belongs here: the moment you need it is the moment you
 * suspect an agent has been turned against you, and that is the worst possible
 * time to be recalling command syntax in a terminal.
 */
export function SessionKeysPanel({
  keys,
  loading,
  error,
  onRetry,
  onRevoke,
  onEditPolicy,
  onEditMerchants,
  pendingKey,
}: {
  keys: SessionKeyView[] | undefined;
  loading: boolean;
  error?: string;
  onRetry?: () => void;
  onRevoke?: (key: SessionKeyView) => void;
  onEditPolicy?: (key: SessionKeyView) => void;
  onEditMerchants?: (key: SessionKeyView) => void;
  /** Address of a key with a transaction in flight, if any. */
  pendingKey?: Address;
}) {
  const [confirming, setConfirming] = useState<Address | null>(null);

  return (
    <Panel
      title="Session keys"
      action={
        keys && keys.length > 0 ? (
          <Caption>{keys.filter((k) => k.active).length} live</Caption>
        ) : null
      }
    >
      {error ? (
        <ErrorState message={error} onRetry={onRetry} />
      ) : loading ? (
        <SkeletonRows rows={2} />
      ) : !keys || keys.length === 0 ? (
        <EmptyState
          title="No session keys yet"
          body="Run giwacard init in a terminal to create one. Until a key is registered, no agent can spend anything."
        />
      ) : (
        <ul className="flex flex-col gap-4">
          {keys.map((key) => {
            const pending = pendingKey?.toLowerCase() === key.address.toLowerCase();
            const isConfirming = confirming?.toLowerCase() === key.address.toLowerCase();

            return (
              <li
                key={key.address}
                className={cx(
                  "rounded-2xl border border-ink/10 p-4 sm:p-5",
                  key.active ? "bg-white/40" : "bg-ink/[0.03]",
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="font-mono text-sm text-ink/80">
                    {shortAddress(key.address)}
                  </span>
                  <Badge tone={key.active ? "settled" : "expired"}>
                    {key.active ? "Live" : "Revoked"}
                  </Badge>
                </div>

                <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-ink/45">
                      Per card
                    </dt>
                    <dd className="mt-0.5 text-ink">
                      {formatUnitsFixed(key.capPerCard, PAYMENT_TOKEN_DECIMALS)}{" "}
                      {PAYMENT_TOKEN_SYMBOL}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-ink/45">
                      Per day
                    </dt>
                    <dd className="mt-0.5 text-ink">
                      {formatUnitsFixed(key.dailyCap, PAYMENT_TOKEN_DECIMALS)}{" "}
                      {PAYMENT_TOKEN_SYMBOL}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-ink/45">
                      Card lifetime
                    </dt>
                    <dd className="mt-0.5 text-ink">
                      {Number(key.maxExpiry) / 3600} h
                    </dd>
                  </div>
                </dl>

                <div className="mt-4">
                  <p className="text-xs uppercase tracking-wide text-ink/45">
                    Shops it may pay
                  </p>
                  {key.merchants.length === 0 ? (
                    <p className="mt-1.5 text-sm text-ink/60">
                      None — so this key cannot make a usable card at all.
                    </p>
                  ) : (
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {key.merchants.map((merchant) => (
                        <li key={merchant}>
                          <Badge>{shortAddress(merchant)}</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                  <Caption className="mt-2">
                    Built from past events, so a shop added outside the range we
                    read may be missing. The contract is the authority.
                  </Caption>
                </div>

                {isConfirming ? (
                  <div className="mt-5 rounded-2xl border border-red-700/20 bg-red-600/[0.06] p-4">
                    <p className="text-sm font-medium text-ink">
                      Revoke this key?
                    </p>
                    <p className="mt-1.5 text-sm text-ink/70">
                      It stops making new cards immediately.{" "}
                      <strong className="font-medium text-ink">
                        The {key.activeCards} card
                        {key.activeCards === 1 ? "" : "s"} it already made stay
                        live
                      </strong>{" "}
                      and can still be charged. Cancel those separately if you
                      need to.
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          onRevoke?.(key);
                          setConfirming(null);
                        }}
                      >
                        {pending ? "Revoking…" : "Yes, revoke it"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirming(null)}
                      >
                        Keep it
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-5 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!key.active || pending}
                      onClick={() => onEditPolicy?.(key)}
                    >
                      Change limits
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!key.active || pending}
                      onClick={() => onEditMerchants?.(key)}
                    >
                      Shops
                    </Button>
                    {key.active && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => setConfirming(key.address)}
                        className="ml-auto border-red-700/25 bg-red-600/10 text-red-800 hover:bg-red-600/15"
                      >
                        Revoke
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

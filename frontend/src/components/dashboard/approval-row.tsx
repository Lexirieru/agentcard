"use client";

import { Badge, Button } from "@/components/ui";
import type { ApprovalActionState } from "@/hooks/use-approvals";
import {
  DaemonRequestError,
  describeDaemonError,
} from "@/lib/approvals/client";
import type { ApprovalView } from "@/lib/approvals/derive";
import {
  absoluteTime,
  formatUnitsFixed,
  isZeroAddress,
  relativeTime,
  shortAddress,
} from "@/lib/format";
import {
  EXPLORER_URL,
  PAYMENT_TOKEN_DECIMALS,
  PAYMENT_TOKEN_SYMBOL,
} from "@/lib/vault/config";

/**
 * One request in the queue, with everything needed to judge it in view.
 *
 * The rule this component exists to enforce: an owner should never have to open
 * something else to decide. Who asked, how much, which merchant, how long the
 * card lives, when it arrived and when the window shuts are all on the row.
 */
export function ApprovalRow({
  view,
  clockReady,
  nowMs,
  actions,
}: {
  view: ApprovalView;
  clockReady: boolean;
  nowMs: number;
  actions: ApprovalActionState;
}) {
  const { record, terms } = view;
  const busy = actions.busyId === record.id;
  const rowError = actions.errorId === record.id ? actions.error : null;

  const openScope = terms !== null && isZeroAddress(terms.merchantScope);

  return (
    <li className="rounded-2xl border border-ink/10 bg-white/40 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">
            {record.agent ?? "Unnamed agent"}
          </p>
          <p
            className="mt-0.5 truncate font-mono text-xs text-ink/50"
            title={record.sessionKey}
          >
            {shortAddress(record.sessionKey)}
          </p>
        </div>
        <Badge tone={view.tone}>{view.label}</Badge>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Fact
          label="Cap"
          value={
            terms
              ? `${formatUnitsFixed(terms.cap, PAYMENT_TOKEN_DECIMALS)} ${PAYMENT_TOKEN_SYMBOL}`
              : "—"
          }
        />
        <Fact
          label="Merchant"
          value={
            terms === null
              ? "—"
              : openScope
                ? "Any merchant"
                : shortAddress(terms.merchantScope)
          }
          title={terms?.merchantScope}
          warn={openScope}
        />
        <Fact
          label="Card expires"
          value={
            terms && clockReady
              ? relativeTime(Number(terms.expiry) * 1000, nowMs)
              : "—"
          }
          title={terms ? absoluteTime(Number(terms.expiry) * 1000) : undefined}
        />
        <Fact
          label="Asked"
          value={clockReady ? relativeTime(record.createdAt, nowMs) : "—"}
          title={absoluteTime(record.createdAt)}
        />
      </dl>

      {record.reason ? (
        <p className="mt-4 border-l-2 border-ink/10 pl-3 text-sm leading-relaxed text-ink/70">
          {record.reason}
        </p>
      ) : null}

      {view.status === "pending" && clockReady ? (
        <p className="mt-3 text-xs text-ink/45">
          Review window closes {relativeTime(record.expiresAt, nowMs)} (
          {absoluteTime(record.expiresAt)}).
        </p>
      ) : null}

      {openScope && view.actionable ? (
        <p className="mt-3 text-xs text-amber-800">
          This card is scoped to <strong>any</strong> merchant. Whoever holds it
          can charge it once, up to the cap.
        </p>
      ) : null}

      {view.blocked ? (
        <p className="mt-4 rounded-xl bg-ink/[0.04] px-3 py-2 text-xs leading-relaxed text-ink/60">
          {view.blocked.message}
        </p>
      ) : null}

      {rowError ? <RowError error={rowError} /> : null}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() => void actions.approve(view)}
          disabled={!view.actionable || busy}
          title={view.blocked?.message}
        >
          {busy && actions.busyAction === "approve"
            ? "Waiting for wallet…"
            : "Approve & sign"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void actions.deny(view)}
          disabled={view.status !== "pending" || busy}
          title={
            view.status !== "pending"
              ? "This request is already resolved."
              : undefined
          }
        >
          {busy && actions.busyAction === "deny" ? "Denying…" : "Deny"}
        </Button>

        {view.relayable ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void actions.relay(view)}
            disabled={busy}
            title="Submit the signed approval yourself instead of waiting for the agent to relay it."
          >
            {busy && actions.busyAction === "relay"
              ? "Submitting…"
              : "Mint it now"}
          </Button>
        ) : null}

        {record.mintTxHash ? (
          <a
            className="rounded-full border border-ink/15 bg-ink/5 px-4 py-2 text-sm text-ink/70 backdrop-blur transition-colors hover:bg-ink/10"
            href={`${EXPLORER_URL}/tx/${record.mintTxHash}`}
            target="_blank"
            rel="noreferrer"
          >
            View mint
          </a>
        ) : null}
      </div>
    </li>
  );
}

function RowError({ error }: { error: Error }) {
  const copy =
    error instanceof DaemonRequestError
      ? describeDaemonError(error.code, error.message)
      : { title: "That did not go through", body: error.message };

  return (
    <div
      role="alert"
      className="mt-4 rounded-xl border border-red-700/20 bg-red-600/[0.06] px-3 py-2"
    >
      <p className="text-xs font-medium text-red-900">{copy.title}</p>
      <p className="mt-1 text-xs leading-relaxed text-red-900/75">{copy.body}</p>
    </div>
  );
}

function Fact({
  label,
  value,
  title,
  warn,
}: {
  label: string;
  value: string;
  title?: string;
  warn?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-ink/40">
        {label}
      </dt>
      <dd
        className={
          warn
            ? "mt-1 truncate text-sm text-amber-800"
            : "mt-1 truncate text-sm text-ink/80"
        }
        title={title}
      >
        {value}
      </dd>
    </div>
  );
}

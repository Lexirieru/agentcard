"use client";

import { useState } from "react";
import { Button, cx, Panel } from "@/components/ui";
import {
  useApprovalActions,
  useApprovalQueue,
} from "@/hooks/use-approvals";
import { DaemonRequestError, describeDaemonError } from "@/lib/approvals/client";
import {
  countActionable,
  emptyQueueCopy,
  evaluateApproval,
  sortApprovals,
} from "@/lib/approvals/derive";
import { APPROVAL_FILTERS, type ApprovalFilter } from "@/lib/approvals/types";
import { CARD_VAULT_ADDRESS } from "@/lib/vault/config";
import { ApprovalRow } from "./approval-row";
import { Caption, EmptyState, ErrorState, SkeletonRows } from "./states";

const FILTER_LABELS: Record<ApprovalFilter, string> = {
  pending: "Pending",
  all: "All",
};

/**
 * The approval queue (R11).
 *
 * Two interactions to approve: press the button, confirm in the wallet. There
 * is no confirmation dialog in between — the terms are already on the row, and
 * the wallet's own signing screen is the confirmation step.
 */
export function ApprovalsPanel({
  ownerAddress,
  paymentToken,
  nowMs,
  clockReady,
}: {
  ownerAddress: string | null;
  paymentToken: string | null;
  nowMs: number;
  clockReady: boolean;
}) {
  const [filter, setFilter] = useState<ApprovalFilter>("pending");
  const queue = useApprovalQueue(filter);
  const actions = useApprovalActions();

  const views = sortApprovals(
    queue.records.map((record) =>
      evaluateApproval(record, {
        nowMs,
        ownerAddress,
        paymentToken,
        vaultAddress: CARD_VAULT_ADDRESS,
      }),
    ),
  );
  const actionable = countActionable(views);

  return (
    <Panel title="Approval queue">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-full border border-ink/10 bg-ink/5 p-1 backdrop-blur">
          {APPROVAL_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setFilter(option)}
              className={cx(
                "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                filter === option
                  ? "bg-ink text-white"
                  : "text-ink/60 hover:text-ink",
              )}
              aria-pressed={filter === option}
            >
              {FILTER_LABELS[option]}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={queue.refetch}
          disabled={queue.isFetching}
        >
          {queue.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      <Caption className="mb-4">
        {actionable === 0
          ? "Requests to mint beyond an agent's onchain session policy land here."
          : `${actionable} request${actionable === 1 ? "" : "s"} waiting on your signature.`}
      </Caption>

      <QueueBody
        filter={filter}
        queue={queue}
        views={views}
        actions={actions}
        nowMs={nowMs}
        clockReady={clockReady}
      />
    </Panel>
  );
}

function QueueBody({
  filter,
  queue,
  views,
  actions,
  nowMs,
  clockReady,
}: {
  filter: ApprovalFilter;
  queue: ReturnType<typeof useApprovalQueue>;
  views: ReturnType<typeof sortApprovals>;
  actions: ReturnType<typeof useApprovalActions>;
  nowMs: number;
  clockReady: boolean;
}) {
  if (queue.isLoading || !clockReady) {
    return <SkeletonRows count={2} />;
  }

  if (queue.isError) {
    const copy =
      queue.error instanceof DaemonRequestError
        ? describeDaemonError(queue.error.code, queue.error.message)
        : describeDaemonError(undefined, queue.error?.message);
    return (
      <ErrorState title={copy.title} body={copy.body} onRetry={queue.refetch} />
    );
  }

  if (views.length === 0) {
    const copy = emptyQueueCopy(filter, queue.records.length);
    return <EmptyState title={copy.title} body={copy.body} />;
  }

  return (
    <ul className="space-y-3">
      {views.map((view) => (
        <ApprovalRow
          key={view.record.id}
          view={view}
          actions={actions}
          nowMs={nowMs}
          clockReady={clockReady}
        />
      ))}
    </ul>
  );
}

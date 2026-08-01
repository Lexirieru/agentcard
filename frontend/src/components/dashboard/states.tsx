import type { ReactNode } from "react";
import { Button, cx } from "@/components/ui";

/**
 * The states every async surface on this dashboard has to be able to render.
 *
 * They live together because they are one design decision, not four: an empty
 * panel, a failed read and a slow read must all look like deliberate answers
 * rather than a page that stopped halfway.
 */

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-ink/15 px-6 py-10 text-center">
      <p className="text-base font-light text-ink">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink/60">
        {body}
      </p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title,
  body,
  onRetry,
  retryLabel = "Try again",
}: {
  title: string;
  body: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div
      role="alert"
      className="rounded-2xl border border-red-700/20 bg-red-600/[0.06] px-6 py-8 text-center"
    >
      <p className="text-base font-light text-ink">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink/65">
        {body}
      </p>
      {onRetry ? (
        <div className="mt-5 flex justify-center">
          <Button variant="ghost" size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Shimmerless skeleton — a calm placeholder, not a slot machine. */
export function SkeletonRows({
  count = 3,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div
      className={cx("space-y-3", className)}
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading…</span>
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className="h-16 animate-pulse rounded-2xl border border-ink/5 bg-ink/[0.04]"
        />
      ))}
    </div>
  );
}

export function SkeletonBlock({ className }: { className?: string }) {
  return (
    <div
      className={cx("animate-pulse rounded-full bg-ink/10", className)}
      aria-hidden="true"
    />
  );
}

/** Small caption used under panel titles and beside counts. */
export function Caption({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={cx("text-xs leading-relaxed text-ink/50", className)}>
      {children}
    </p>
  );
}

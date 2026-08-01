import type { ReactNode } from "react";
import { cx } from "./cx";

export type BadgeTone = "neutral" | "pending" | "settled" | "expired" | "danger";

export type BadgeProps = {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
};

/**
 * The landing page's pill shape, re-tuned to carry card and approval state.
 * `pending` is deliberately distinct from `settled`: a preconfirmed transaction
 * is not yet final, and the dashboard must never present it as if it were.
 */
const TONES: Record<BadgeTone, string> = {
  neutral: "border-ink/15 bg-ink/10 text-ink/80",
  pending: "border-amber-600/25 bg-amber-500/15 text-amber-800",
  settled: "border-emerald-700/20 bg-emerald-600/15 text-emerald-800",
  expired: "border-ink/10 bg-ink/5 text-ink/45",
  danger: "border-red-700/25 bg-red-600/15 text-red-800",
};

export function Badge({ tone = "neutral", children, className }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

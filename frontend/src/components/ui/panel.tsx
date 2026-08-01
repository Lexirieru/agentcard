import type { ReactNode } from "react";
import { cx } from "./cx";

export type PanelProps = {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
};

/** A bordered surface on the canvas — the dashboard's unit of grouping. */
export function Panel({ title, action, children, className }: PanelProps) {
  return (
    <section
      className={cx(
        "rounded-3xl border border-ink/10 bg-white/60 p-6 backdrop-blur",
        className,
      )}
    >
      {(title || action) && (
        <header className="mb-5 flex items-center justify-between gap-4">
          {title && (
            <h2 className="text-sm font-medium uppercase tracking-wide text-ink/60">
              {title}
            </h2>
          )}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

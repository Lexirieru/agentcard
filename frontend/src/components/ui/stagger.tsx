import type { ReactNode } from "react";
import { cx } from "./cx";

export type StaggerProps = {
  /** Seconds of delay before this element enters. */
  delay?: number;
  children: ReactNode;
  className?: string;
};

/**
 * Wraps content in the landing page's entrance animation so panels arrive in a
 * deliberate order instead of all at once. Respects prefers-reduced-motion via
 * the .anim-stagger rule in globals.css.
 */
export function Stagger({ delay = 0, children, className }: StaggerProps) {
  return (
    <div
      className={cx("anim-stagger", className)}
      style={delay ? { animationDelay: `${delay}s` } : undefined}
    >
      {children}
    </div>
  );
}

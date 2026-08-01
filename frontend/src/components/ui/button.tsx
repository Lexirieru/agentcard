import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /**
   * `solid` is the landing page's primary control (ink fill on canvas).
   * `ghost` mirrors its secondary control (translucent fill, hairline border).
   */
  variant?: "solid" | "ghost";
  size?: "sm" | "md";
};

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-full font-medium transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink " +
  "disabled:cursor-not-allowed disabled:opacity-40";

const VARIANTS = {
  solid: "bg-ink text-white hover:bg-ink/90",
  ghost: "border border-ink/15 bg-ink/5 text-ink backdrop-blur hover:bg-ink/10",
} as const;

const SIZES = {
  sm: "px-4 py-2 text-sm",
  md: "px-6 py-3 text-sm",
} as const;

export function Button({
  variant = "solid",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(BASE, VARIANTS[variant], SIZES[size], className)}
      {...props}
    />
  );
}

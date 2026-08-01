/**
 * Display helpers. Pure and unit-tested, because a rounding or sign mistake in
 * a money column is indistinguishable from a protocol bug to whoever reads it.
 */

/**
 * Render a base-unit amount with a fixed number of fraction digits.
 *
 * Truncates rather than rounds: showing 10.00 for 9.999 would overstate what an
 * owner can actually spend, and every number on this dashboard is a spendable
 * balance or a settled charge.
 */
export function formatUnitsFixed(
  value: bigint,
  decimals: number,
  fractionDigits = 2,
): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fraction = abs % scale;

  const groupedWhole = groupThousands(whole.toString());
  if (fractionDigits <= 0) {
    return `${negative ? "-" : ""}${groupedWhole}`;
  }

  // Pad to `decimals` first, then cut — slicing the unpadded remainder would
  // read 0.000001 as 0.1 for a 6-decimal token.
  const padded = fraction.toString().padStart(decimals, "0");
  const digits = padded.slice(0, fractionDigits).padEnd(fractionDigits, "0");
  return `${negative ? "-" : ""}${groupedWhole}.${digits}`;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `0x1234…cdef` — enough to recognise an address, short enough for a row. */
export function shortAddress(
  address: string | null | undefined,
  lead = 6,
  tail = 4,
): string {
  if (!address) return "—";
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/** The zero address, which `merchantScope` uses to mean "any merchant". */
export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as const;

export function isZeroAddress(address: string | null | undefined): boolean {
  return typeof address === "string" && address.toLowerCase() === ZERO_ADDRESS;
}

/**
 * Coarse relative time: "in 4h", "12m ago", "just now".
 *
 * Deliberately low-resolution — the exact instant is in the title attribute of
 * whatever renders this, and a ticking seconds counter would force a re-render
 * every second for no decision-making value.
 */
export function relativeTime(targetMs: number, nowMs: number): string {
  const deltaMs = targetMs - nowMs;
  const future = deltaMs > 0;
  const seconds = Math.floor(Math.abs(deltaMs) / 1000);

  if (seconds < 45) return future ? "in moments" : "just now";

  const units: Array<[limit: number, size: number, suffix: string]> = [
    [60 * 60, 60, "m"],
    [60 * 60 * 24, 60 * 60, "h"],
    [60 * 60 * 24 * 30, 60 * 60 * 24, "d"],
    [Number.POSITIVE_INFINITY, 60 * 60 * 24 * 30, "mo"],
  ];

  for (const [limit, size, suffix] of units) {
    if (seconds < limit) {
      const value = Math.max(1, Math.floor(seconds / size));
      return future ? `in ${value}${suffix}` : `${value}${suffix} ago`;
    }
  }
  return future ? "later" : "a while ago";
}

/**
 * Absolute timestamp for the `title` tooltip.
 *
 * Rendered from a fixed locale and UTC so the server-rendered string and the
 * client-hydrated string are byte-identical; `toLocaleString()` with the
 * viewer's locale is a classic hydration mismatch.
 */
export function absoluteTime(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

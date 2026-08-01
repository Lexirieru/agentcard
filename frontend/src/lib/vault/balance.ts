/**
 * The owner's money, split three ways.
 *
 * Mirrors `CardVault.availableBalanceOf`: `balance - escrowedTotal`. The
 * contract can subtract without a guard because its own invariants keep escrow
 * below balance; a *client* has no such guarantee — it reads the two numbers in
 * separate calls that can land either side of a mint — so this clamps at zero
 * rather than rendering a negative balance during that window.
 */

export interface VaultBalance {
  /** Everything deposited and not yet withdrawn or spent. */
  total: bigint;
  /** Sum of the caps of still-active cards. Locked, not spent. */
  escrowed: bigint;
  /** What can back a new card or leave the vault: `total - escrowed`. */
  available: bigint;
}

export function computeBalance(total: bigint, escrowed: bigint): VaultBalance {
  const clampedEscrow = escrowed < 0n ? 0n : escrowed;
  const available = total > clampedEscrow ? total - clampedEscrow : 0n;
  return { total, escrowed: clampedEscrow, available };
}

/**
 * Escrow as a percentage of the total, for the balance bar.
 *
 * Returns 0 for an empty vault so the bar renders empty rather than full — a
 * vault with nothing in it has nothing locked.
 */
export function escrowedFraction(balance: VaultBalance): number {
  if (balance.total <= 0n) return 0;
  const basisPoints = (balance.escrowed * 10_000n) / balance.total;
  return Math.min(1, Number(basisPoints) / 10_000);
}

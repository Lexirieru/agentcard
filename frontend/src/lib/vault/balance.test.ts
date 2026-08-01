import { describe, expect, test } from "bun:test";
import { computeBalance, escrowedFraction } from "./balance";

describe("computeBalance", () => {
  test("available is balance minus escrow", () => {
    const balance = computeBalance(1_000_000n, 250_000n);
    expect(balance.total).toBe(1_000_000n);
    expect(balance.escrowed).toBe(250_000n);
    expect(balance.available).toBe(750_000n);
  });

  test("a fully escrowed vault has nothing available", () => {
    expect(computeBalance(500n, 500n).available).toBe(0n);
  });

  test("an empty vault is all zeroes, not NaN", () => {
    expect(computeBalance(0n, 0n)).toEqual({
      total: 0n,
      escrowed: 0n,
      available: 0n,
    });
  });

  test("clamps at zero when the two reads disagree", () => {
    // balanceOf and escrowedOf are separate calls; a mint can land between
    // them, so the client can briefly see escrow above balance.
    expect(computeBalance(100n, 400n).available).toBe(0n);
  });

  test("a negative escrow reading is treated as zero", () => {
    const balance = computeBalance(100n, -50n);
    expect(balance.escrowed).toBe(0n);
    expect(balance.available).toBe(100n);
  });

  test("handles amounts far beyond Number.MAX_SAFE_INTEGER", () => {
    const total = 10n ** 30n;
    const escrowed = 4n * 10n ** 29n;
    expect(computeBalance(total, escrowed).available).toBe(6n * 10n ** 29n);
  });
});

describe("escrowedFraction", () => {
  test("is the escrowed share of the total", () => {
    expect(escrowedFraction(computeBalance(1000n, 250n))).toBeCloseTo(0.25, 5);
  });

  test("an empty vault reads as nothing locked, not everything", () => {
    expect(escrowedFraction(computeBalance(0n, 0n))).toBe(0);
  });

  test("never exceeds one", () => {
    expect(escrowedFraction({ total: 100n, escrowed: 400n, available: 0n })).toBe(1);
  });
});

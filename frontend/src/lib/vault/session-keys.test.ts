import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import {
  deriveSessionKeys,
  MAX_EXPIRY_HOURS,
  parseTokenAmount,
  validatePolicyForm,
} from "./session-keys";

const KEY_A = "0xAAAAaaaAAAaaAAAAaaAAaAAAaAaAAaAaAaaaAAAa" as Address;
const KEY_B = "0xBbBBBbbbBBbBbbBbBBbbbbBbBBbbbBbBbbbbBBbB" as Address;
const SHOP = "0xCCccCCCcccCCCcCCcCcCCCcCcCcCcCCcCCcCcCcC" as Address;
const OTHER_SHOP = "0xDdDdddDdDDDddddDDddDDdDdddDDDDddDdDdDdDD" as Address;

function reg(sessionKey: Address, block: bigint, cap = 10n, daily = 50n) {
  return {
    sessionKey,
    capPerCard: cap,
    dailyCap: daily,
    maxExpiry: 86_400n,
    blockNumber: block,
    logIndex: 0,
  };
}

describe("deriveSessionKeys", () => {
  test("builds one entry per registered key", () => {
    const keys = deriveSessionKeys({
      registered: [reg(KEY_A, 10n), reg(KEY_B, 11n)],
      merchants: [],
      revoked: [],
    });
    expect(keys).toHaveLength(2);
    expect(keys.map((k) => k.address).sort()).toEqual([KEY_A, KEY_B].sort());
  });

  test("a revoked key reads inactive", () => {
    const [key] = deriveSessionKeys({
      registered: [reg(KEY_A, 10n)],
      merchants: [],
      revoked: [{ sessionKey: KEY_A, blockNumber: 12n, logIndex: 0 }],
    });
    expect(key?.active).toBe(false);
  });

  test("re-registering after a revoke brings the key back", () => {
    const [key] = deriveSessionKeys({
      registered: [reg(KEY_A, 10n), reg(KEY_A, 20n, 25n, 99n)],
      merchants: [],
      revoked: [{ sessionKey: KEY_A, blockNumber: 15n, logIndex: 0 }],
    });
    expect(key?.active).toBe(true);
    // The later registration's policy is the one that survives.
    expect(key?.capPerCard).toBe(25n);
    expect(key?.dailyCap).toBe(99n);
  });

  test("revoking after a re-registration kills it again", () => {
    const [key] = deriveSessionKeys({
      registered: [reg(KEY_A, 10n), reg(KEY_A, 20n)],
      merchants: [],
      revoked: [{ sessionKey: KEY_A, blockNumber: 25n, logIndex: 0 }],
    });
    expect(key?.active).toBe(false);
  });

  test("ordering is by block and log index, not array position", () => {
    // Logs arrive newest-first here; the older registration must not win.
    const [key] = deriveSessionKeys({
      registered: [reg(KEY_A, 20n, 25n), reg(KEY_A, 10n, 5n)],
      merchants: [],
      revoked: [],
    });
    expect(key?.capPerCard).toBe(25n);
  });

  test("two events in one block are separated by log index", () => {
    const [key] = deriveSessionKeys({
      registered: [{ ...reg(KEY_A, 10n), logIndex: 0 }],
      merchants: [],
      revoked: [{ sessionKey: KEY_A, blockNumber: 10n, logIndex: 5 }],
    });
    expect(key?.active).toBe(false);
  });

  test("a merchant later denied drops off the list", () => {
    const [key] = deriveSessionKeys({
      registered: [reg(KEY_A, 10n)],
      merchants: [
        { sessionKey: KEY_A, merchant: SHOP, allowed: true, blockNumber: 11n, logIndex: 0 },
        { sessionKey: KEY_A, merchant: OTHER_SHOP, allowed: true, blockNumber: 11n, logIndex: 1 },
        { sessionKey: KEY_A, merchant: SHOP, allowed: false, blockNumber: 12n, logIndex: 0 },
      ],
      revoked: [],
    });
    expect(key?.merchants).toEqual([OTHER_SHOP]);
  });

  test("merchant events for an unknown key are ignored", () => {
    const keys = deriveSessionKeys({
      registered: [reg(KEY_A, 10n)],
      merchants: [
        { sessionKey: KEY_B, merchant: SHOP, allowed: true, blockNumber: 11n, logIndex: 0 },
      ],
      revoked: [],
    });
    expect(keys).toHaveLength(1);
    expect(keys[0]?.merchants).toEqual([]);
  });

  test("active cards are attached by key, case-insensitively", () => {
    const [key] = deriveSessionKeys({
      registered: [reg(KEY_A, 10n)],
      merchants: [],
      revoked: [],
      activeCardsByKey: { [KEY_A.toLowerCase()]: 3 },
    });
    expect(key?.activeCards).toBe(3);
  });

  test("live keys sort ahead of revoked ones", () => {
    const keys = deriveSessionKeys({
      registered: [reg(KEY_A, 10n), reg(KEY_B, 11n)],
      merchants: [],
      revoked: [{ sessionKey: KEY_A, blockNumber: 12n, logIndex: 0 }],
    });
    expect(keys[0]?.address).toBe(KEY_B);
    expect(keys[0]?.active).toBe(true);
  });
});

describe("parseTokenAmount", () => {
  test("whole numbers scale by the decimals", () => {
    expect(parseTokenAmount("10", 6)).toBe(10_000_000n);
  });

  test("fractions are padded, not multiplied through a float", () => {
    // 0.1 * 1e6 in floating point is 100000.00000000001.
    expect(parseTokenAmount("0.1", 6)).toBe(100_000n);
    expect(parseTokenAmount("2.5", 6)).toBe(2_500_000n);
    expect(parseTokenAmount("0.000001", 6)).toBe(1n);
  });

  test("zero parses", () => {
    expect(parseTokenAmount("0", 6)).toBe(0n);
  });

  test("more precision than the token has is rejected, not truncated", () => {
    expect(parseTokenAmount("0.0000001", 6)).toBeNull();
  });

  test("rubbish is rejected", () => {
    for (const bad of ["", " ", "abc", "1.2.3", "-1", "1e6", "1,5", "."]) {
      expect(parseTokenAmount(bad, 6)).toBeNull();
    }
  });
});

describe("validatePolicyForm", () => {
  const good = { capPerCard: "10", dailyCap: "50", maxExpiryHours: "24" };

  test("accepts a sane policy and converts it", () => {
    const result = validatePolicyForm(good, 6);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.capPerCard).toBe(10_000_000n);
    expect(result.value.dailyCap).toBe(50_000_000n);
    expect(result.value.maxExpiry).toBe(86_400n);
  });

  test("rejects a zero per-card limit", () => {
    const result = validatePolicyForm({ ...good, capPerCard: "0" }, 6);
    expect(result.ok).toBe(false);
  });

  test("rejects a daily limit below the per-card limit", () => {
    // Otherwise the second card of the day could never be made.
    const result = validatePolicyForm({ ...good, dailyCap: "5" }, 6);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Daily limit");
  });

  test("rejects a non-integer lifetime", () => {
    expect(validatePolicyForm({ ...good, maxExpiryHours: "1.5" }, 6).ok).toBe(false);
  });

  test("rejects a lifetime past the ceiling", () => {
    const result = validatePolicyForm(
      { ...good, maxExpiryHours: String(MAX_EXPIRY_HOURS + 1) },
      6,
    );
    expect(result.ok).toBe(false);
  });

  test("rejects rubbish amounts with a readable reason", () => {
    const result = validatePolicyForm({ ...good, capPerCard: "ten" }, 6);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Per-card limit");
  });
});

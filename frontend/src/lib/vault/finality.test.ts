import { describe, expect, test } from "bun:test";
import {
  deriveFinality,
  finalityHint,
  finalityLabel,
  finalityTone,
} from "./finality";

describe("deriveFinality", () => {
  test("a block at or below the finalized head is settled", () => {
    expect(deriveFinality(100n, 100n)).toBe("settled");
    expect(deriveFinality(99n, 100n)).toBe("settled");
  });

  test("a block above the finalized head is still pending", () => {
    expect(deriveFinality(101n, 100n)).toBe("pending");
  });

  test("a preconfirmed transaction with no block is pending", () => {
    // The Flashblocks case: the sequencer has promised inclusion, nothing more.
    expect(deriveFinality(null, 100n)).toBe("pending");
    expect(deriveFinality(undefined, 100n)).toBe("pending");
  });

  test("an unknown finality horizon never yields settled", () => {
    expect(deriveFinality(100n, null)).toBe("pending");
    expect(deriveFinality(100n, undefined)).toBe("pending");
  });

  test("block zero is not mistaken for a missing block", () => {
    expect(deriveFinality(0n, 0n)).toBe("settled");
  });
});

describe("finality presentation", () => {
  test("maps onto the shared Badge tones", () => {
    expect(finalityTone("settled")).toBe("settled");
    expect(finalityTone("pending")).toBe("pending");
  });

  test("labels do not overclaim", () => {
    expect(finalityLabel("pending")).toBe("Pending");
    expect(finalityLabel("settled")).toBe("Settled");
  });

  test("explains an unknown horizon differently from a young block", () => {
    expect(finalityHint("pending", null)).toContain("not reported a finalized");
    expect(finalityHint("pending", 10n)).toContain("Preconfirmed");
    expect(finalityHint("settled", 10n)).toContain("finalized block");
  });
});

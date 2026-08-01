import { describe, expect, test } from "bun:test";
import { logFromBlock, parseAddressEnv, parseBigIntEnv } from "./config";

describe("parseAddressEnv", () => {
  test("accepts a checksummed or lowercase address", () => {
    expect(parseAddressEnv("0x1111111111111111111111111111111111111111")).toBe(
      "0x1111111111111111111111111111111111111111",
    );
  });

  test("trims surrounding whitespace", () => {
    expect(parseAddressEnv("  0xAbC1111111111111111111111111111111111111 ")).toBe(
      "0xAbC1111111111111111111111111111111111111",
    );
  });

  test("returns null rather than a plausible-looking wrong address", () => {
    expect(parseAddressEnv(undefined)).toBeNull();
    expect(parseAddressEnv("")).toBeNull();
    expect(parseAddressEnv("0x123")).toBeNull();
    expect(parseAddressEnv("1111111111111111111111111111111111111111")).toBeNull();
  });
});

describe("parseBigIntEnv", () => {
  test("parses a decimal string", () => {
    expect(parseBigIntEnv("12345", 0n)).toBe(12345n);
  });

  test("falls back on anything unusable", () => {
    expect(parseBigIntEnv(undefined, 7n)).toBe(7n);
    expect(parseBigIntEnv("-1", 7n)).toBe(7n);
    expect(parseBigIntEnv("1.5", 7n)).toBe(7n);
    expect(parseBigIntEnv("0xff", 7n)).toBe(7n);
  });
});

describe("logFromBlock", () => {
  test("never reaches back before the vault existed", () => {
    expect(logFromBlock(1_000n, 900n, 100_000n)).toBe(900n);
  });

  test("caps the window so a public RPC does not refuse the query", () => {
    expect(logFromBlock(500_000n, 0n, 100_000n)).toBe(400_000n);
  });

  test("clamps at genesis on a young chain", () => {
    expect(logFromBlock(50n, 0n, 100_000n)).toBe(0n);
  });

  test("the deploy block wins whenever it is the tighter bound", () => {
    expect(logFromBlock(500_000n, 450_000n, 100_000n)).toBe(450_000n);
  });
});

import { describe, expect, test } from "bun:test";
import {
  absoluteTime,
  formatUnitsFixed,
  isZeroAddress,
  relativeTime,
  shortAddress,
} from "./format";

describe("formatUnitsFixed", () => {
  test("formats 6-decimal base units the way gUSD is denominated", () => {
    expect(formatUnitsFixed(5_000_000n, 6)).toBe("5.00");
    expect(formatUnitsFixed(1_234_567n, 6)).toBe("1.23");
  });

  test("truncates rather than rounds up", () => {
    // 9.999999 must never read as 10.00: it would overstate what is spendable.
    expect(formatUnitsFixed(9_999_999n, 6)).toBe("9.99");
  });

  test("pads the fraction before slicing it", () => {
    expect(formatUnitsFixed(1n, 6)).toBe("0.00");
    expect(formatUnitsFixed(100_000n, 6)).toBe("0.10");
  });

  test("groups thousands", () => {
    expect(formatUnitsFixed(1_234_567_890_123n, 6)).toBe("1,234,567.89");
  });

  test("handles zero and negatives", () => {
    expect(formatUnitsFixed(0n, 6)).toBe("0.00");
    expect(formatUnitsFixed(-2_500_000n, 6)).toBe("-2.50");
  });

  test("supports other precisions", () => {
    expect(formatUnitsFixed(10n ** 18n, 18)).toBe("1.00");
    expect(formatUnitsFixed(1_500_000n, 6, 0)).toBe("1");
    expect(formatUnitsFixed(1_234_567n, 6, 4)).toBe("1.2345");
  });

  test("does not lose precision on amounts beyond double range", () => {
    expect(formatUnitsFixed(10n ** 30n, 6)).toBe(
      "1,000,000,000,000,000,000,000,000.00",
    );
  });
});

describe("shortAddress", () => {
  test("keeps both ends recognisable", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe(
      "0x1234…5678",
    );
  });

  test("renders an em dash for nothing", () => {
    expect(shortAddress(null)).toBe("—");
    expect(shortAddress(undefined)).toBe("—");
  });

  test("leaves already-short strings alone", () => {
    expect(shortAddress("0xabc")).toBe("0xabc");
  });
});

describe("isZeroAddress", () => {
  test("recognises the open-merchant sentinel in any casing", () => {
    expect(isZeroAddress("0x0000000000000000000000000000000000000000")).toBe(true);
    expect(isZeroAddress("0x0000000000000000000000000000000000000000".toUpperCase().replace("0X", "0x"))).toBe(true);
  });

  test("a real address is not the zero address", () => {
    expect(isZeroAddress("0x1111111111111111111111111111111111111111")).toBe(false);
    expect(isZeroAddress(null)).toBe(false);
  });
});

describe("relativeTime", () => {
  const now = 1_800_000_000_000;

  test("describes the near past and near future", () => {
    expect(relativeTime(now, now)).toBe("just now");
    expect(relativeTime(now + 5_000, now)).toBe("in moments");
  });

  test("counts minutes, hours and days", () => {
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now + 3 * 3_600_000, now)).toBe("in 3h");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(relativeTime(now + 90 * 86_400_000, now)).toBe("in 3mo");
  });
});

describe("absoluteTime", () => {
  test("is locale-independent so SSR and hydration agree", () => {
    expect(absoluteTime(0)).toBe("1970-01-01 00:00:00 UTC");
  });
});

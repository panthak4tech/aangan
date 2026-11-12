import { describe, expect, it } from "vitest";
import { formatBytes, formatEta, formatRate } from "./format";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1.00 KB"],
    [1536, "1.50 KB"],
    [5 * 1024 ** 3, "5.00 GB"],
    [250 * 1024 ** 2, "250 MB"],
  ])("%d -> %s", (value, expected) => expect(formatBytes(value)).toBe(expected));

  it("rejects negative and non-finite values", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatEta and formatRate", () => {
  it("formats transfer rates and remaining durations", () => {
    expect(formatEta(null)).toBe("—");
    expect(formatEta(30)).toBe("30 s");
    expect(formatEta(125)).toBe("2 min 5 s");
    expect(formatEta(7260)).toBe("2 h 1 min");
    expect(formatRate(0)).toBe("—");
    expect(formatRate(2 * 1024 ** 2)).toBe("2.00 MB/s");
  });
});

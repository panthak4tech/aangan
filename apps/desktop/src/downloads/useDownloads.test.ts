import { describe, expect, it } from "vitest";
import type { DownloadProgress } from "@/api/types";
import { isActive, percent } from "./useDownloads";

describe("percent", () => {
  it("clamps progress and handles invalid totals", () => {
    expect(percent({ done: 0, total: 0 })).toBe(0);
    expect(percent({ done: 50, total: 200 })).toBe(25);
    expect(percent({ done: 300, total: 200 })).toBe(100);
    expect(percent({ done: -1, total: 200 })).toBe(0);
  });
});

describe("isActive", () => {
  const base: Omit<DownloadProgress, "state"> = {
    id: "model",
    done: 0,
    total: 100,
    bytesPerSec: 0,
    etaSecs: null,
  };

  it("treats queued, downloading, and verifying items as active", () => {
    expect(isActive({ ...base, state: { kind: "queued" } })).toBe(true);
    expect(isActive({ ...base, state: { kind: "downloading" } })).toBe(true);
    expect(isActive({ ...base, state: { kind: "verifying" } })).toBe(true);
  });

  it("treats paused, done, cancelled, and failed items as inactive", () => {
    expect(isActive({ ...base, state: { kind: "paused" } })).toBe(false);
    expect(isActive({ ...base, state: { kind: "done" } })).toBe(false);
    expect(isActive({ ...base, state: { kind: "cancelled" } })).toBe(false);
    expect(isActive({ ...base, state: { kind: "failed", message: "disk error" } })).toBe(false);
  });
});

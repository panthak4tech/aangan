import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MODELS, PRESETS } from "@/api/presets";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("browser API wrappers", () => {
  it("returns a cloned preset and clears unrequested bandwidth measurements", async () => {
    vi.useFakeTimers();
    const { scanHardware } = await import("@/api/api");
    const request = scanHardware();
    await vi.advanceTimersByTimeAsync(1500);
    const profile = await request;

    expect(profile).not.toBe(PRESETS.desktop_3060);
    expect(profile.memory.read_bandwidth_gbps).toBeNull();
    expect(profile.memory.bandwidth_source).toBe("not_measured");
    expect(profile.gpus).toEqual(PRESETS.desktop_3060.gpus);
  });

  it("rejects mock scans when the developer failure switch is enabled", async () => {
    vi.useFakeTimers();
    const devPreset = await import("@/api/devPreset");
    devPreset.setFailScans(true);
    const { scanHardware } = await import("@/api/api");
    const request = scanHardware(false);
    const rejection = expect(request).rejects.toThrow("mock_scan_failed");
    await vi.advanceTimersByTimeAsync(1500);

    await rejection;
    devPreset.setFailScans(false);
  });

  it("ranks model recommendations in the browser mock", async () => {
    vi.useFakeTimers();
    const { recommendModels } = await import("@/api/api");
    const request = recommendModels(PRESETS.desktop_3060, 4096);
    await vi.advanceTimersByTimeAsync(1500);
    const recommendations = await request;

    expect(recommendations).toHaveLength(MODELS.length);
    expect(recommendations[0].rank).toBe(1);
  });
});

it("delegates scans and recommendations to Tauri when its runtime is present", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  vi.mocked(invoke)
    .mockResolvedValueOnce(PRESETS.desktop_3060)
    .mockResolvedValueOnce([]);
  const { recommendModels, scanHardware } = await import("@/api/api");

  await expect(scanHardware(true)).resolves.toEqual(PRESETS.desktop_3060);
  await expect(recommendModels(PRESETS.desktop_3060, 8192)).resolves.toEqual([]);
  expect(invoke).toHaveBeenNthCalledWith(1, "scan_hardware", { measureBandwidth: true });
  expect(invoke).toHaveBeenNthCalledWith(2, "recommend_models", {
    profile: PRESETS.desktop_3060,
    context: 8192,
  });
});

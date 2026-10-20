import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MODELS, PRESETS } from "@/api/presets";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

import { save } from "@tauri-apps/plugin-dialog";

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

  it("does nothing when the native save dialog is cancelled", async () => {
    vi.mocked(save).mockResolvedValue(null);
    const { saveHardwareReport } = await import("@/api/api");

    await expect(saveHardwareReport("{}")).resolves.toBeNull();
    expect(save).toHaveBeenCalledWith({
      defaultPath: expect.stringMatching(/^aangan-hardware-report-\d{4}-\d{2}-\d{2}\.json$/),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("saves the report to the selected path", async () => {
    vi.mocked(save).mockResolvedValue("C:\\reports\\report.json");
    vi.mocked(invoke).mockResolvedValue({ path: "C:\\reports\\report.json", bytes: 2 });
    const { saveHardwareReport } = await import("@/api/api");

    await expect(saveHardwareReport("{}")).resolves.toBe("C:\\reports\\report.json");
    expect(invoke).toHaveBeenCalledWith("save_text_file", {
      path: "C:\\reports\\report.json",
      contents: "{}",
    });
  });

  it("propagates native save failures", async () => {
    vi.mocked(save).mockResolvedValue("C:\\reports\\report.json");
    vi.mocked(invoke).mockRejectedValue(new Error("disk full"));
    const { saveHardwareReport } = await import("@/api/api");

    await expect(saveHardwareReport("{}")).rejects.toThrow("disk full");
  });

  it("copies report contents through the clipboard API", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { copyHardwareReport } = await import("@/api/api");

    await copyHardwareReport("{}");
    expect(writeText).toHaveBeenCalledWith("{}");
  });

  it("delegates app-path lookup to the Tauri command", async () => {
    const appPaths = {
      data_dir: "C:\\Users\\partv\\AppData\\Local\\io.github.panthak4tech.aangan",
      data_dir_exists: true,
    };
    vi.mocked(invoke).mockResolvedValue(appPaths);
    const { getAppPaths } = await import("@/api/api");

    await expect(getAppPaths()).resolves.toEqual(appPaths);
    expect(invoke).toHaveBeenCalledWith("get_app_paths");
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

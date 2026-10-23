import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import packageMetadata from "../../package.json";
import { APP_INFO, MODELS, PRESETS } from "@/api/presets";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

import { save } from "@tauri-apps/plugin-dialog";

beforeEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  window.localStorage.removeItem("aangan.catalog.subscribedFamilies");
  window.localStorage.removeItem("aangan.catalog.refreshAlwaysAllowed");
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("browser API wrappers", () => {
  it("uses the desktop package version for About metadata", () => {
    expect(APP_INFO.version).toBe(packageMetadata.version);
  });

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

  it("opens the bundled third-party notices through Tauri", async () => {
    const { openThirdPartyNotices } = await import("@/api/api");

    await openThirdPartyNotices();
    expect(invoke).toHaveBeenCalledWith("open_third_party_notices");
  });

  it("opens the Aangan repository through the Rust command", async () => {
    const { openAanganRepository } = await import("@/api/api");

    await openAanganRepository();
    expect(invoke).toHaveBeenCalledWith("open_aangan_repository");
  });

  it("uses browser storage for catalog preferences without refreshing over the webview", async () => {
    const {
      getCatalogInfo,
      refreshCatalog,
      resetCatalog,
      setCatalogRefreshConsent,
      setSubscribedFamilies,
    } = await import("@/api/api");

    const initial = await getCatalogInfo();
    expect(initial.subscribed_families).toEqual(["qwen2.5"]);
    expect(initial.refresh_catalog_always_allowed).toBe(false);
    await setSubscribedFamilies([]);
    await setCatalogRefreshConsent(true);
    expect((await getCatalogInfo()).subscribed_families).toEqual([]);
    expect((await getCatalogInfo()).refresh_catalog_always_allowed).toBe(true);
    await expect(resetCatalog()).resolves.toEqual(await getCatalogInfo());
    await expect(refreshCatalog(true)).rejects.toThrow(
      "Catalog refresh is available only in the desktop app.",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("surfaces invalid browser catalog settings", async () => {
    window.localStorage.setItem("aangan.catalog.subscribedFamilies", "{");
    const { getCatalogInfo } = await import("@/api/api");

    await expect(getCatalogInfo()).rejects.toThrow();
  });
});

it("delegates scans and recommendations to Tauri when its runtime is present", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  const info = {
      generated_at: "2026-10-21T13:30:00Z",
      families: ["qwen2.5"],
      subscribed_families: ["qwen2.5"],
      refresh_catalog_always_allowed: true,
      warning: null,
      signature_verified: false,
  };
  const refreshResult = {
    generated_at: info.generated_at,
    model_count: 7,
    added: 0,
    updated: 0,
  };
  vi.mocked(invoke)
    .mockResolvedValueOnce(PRESETS.desktop_3060)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(info)
    .mockResolvedValueOnce(info)
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(info)
    .mockResolvedValueOnce(refreshResult);
  const {
    getCatalogInfo,
    recommendModels,
    refreshCatalog,
    resetCatalog,
    scanHardware,
    setCatalogRefreshConsent,
    setSubscribedFamilies,
  } = await import("@/api/api");

  await expect(scanHardware(true)).resolves.toEqual(PRESETS.desktop_3060);
  await expect(recommendModels(PRESETS.desktop_3060, 8192)).resolves.toEqual([]);
  expect(await getCatalogInfo()).toEqual(info);
  await setSubscribedFamilies(["qwen2.5"]);
  await setCatalogRefreshConsent(true);
  await resetCatalog();
  await expect(refreshCatalog(false)).resolves.toEqual(refreshResult);
  expect(invoke).toHaveBeenNthCalledWith(1, "scan_hardware", { measureBandwidth: true });
  expect(invoke).toHaveBeenNthCalledWith(2, "recommend_models", {
    profile: PRESETS.desktop_3060,
    context: 8192,
  });
  expect(invoke).toHaveBeenNthCalledWith(3, "get_catalog_info");
  expect(invoke).toHaveBeenNthCalledWith(4, "set_subscribed_families", {
    families: ["qwen2.5"],
  });
  expect(invoke).toHaveBeenNthCalledWith(5, "set_catalog_refresh_consent", {
    alwaysAllowed: true,
  });
  expect(invoke).toHaveBeenNthCalledWith(6, "reset_catalog");
  expect(invoke).toHaveBeenNthCalledWith(7, "refresh_catalog", { consentOnce: false });
});

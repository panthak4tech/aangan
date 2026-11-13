import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import packageMetadata from "../../package.json";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelDownload,
  copyHardwareReport,
  clearNetworkActivity,
  chooseModelFolder,
  deleteStorageFile,
  getAppPaths,
  getCatalogInfo,
  getModelFolder,
  getNetworkActivity,
  getNetworkState,
  getStorageInfo,
  listenNetworkState,
  listenDownloadProgress,
  listDownloads,
  openModelFileFolder,
  openModelFolder,
  pauseDownload,
  recommendModels,
  refreshCatalog,
  resetCatalog,
  openNetworkDocs,
  saveHardwareReport,
  scanHardware,
  resumeDownload,
  setCatalogRefreshConsent,
  setOfflineMode,
  setModelFolder,
  setSubscribedFamilies,
  startDownload,
} from "@/api/api";
import type { DownloadProgress, HardwareProfile, StorageInfo } from "@/api/types";
import { MODELS, PRESETS } from "@/api/presets";
import { rankModels } from "@/api/estimate";
import { en } from "@/i18n/en";
import { ModelsView } from "@/app/views/ModelsView";
import { ScanView } from "@/app/views/ScanView";
import { SettingsView } from "@/app/views/SettingsView";
import { DownloadsButton, DownloadsDrawer } from "@/app/downloads/DownloadsDrawer";
import { FirstRunWizard } from "@/app/wizard/FirstRunWizard";
import { TooltipProvider } from "@/components/primitives/tooltip";
import { ToastProvider } from "@/components/ui/toast-provider";
import { DownloadsProvider, useDownloads } from "@/downloads/useDownloads";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}));
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

vi.mock("@/api/api", async () => {
  const { default: metadata } = await import("../../package.json");
  return {
    cancelDownload: vi.fn(),
    copyHardwareReport: vi.fn(),
    clearNetworkActivity: vi.fn(),
    chooseModelFolder: vi.fn(),
    deleteStorageFile: vi.fn(),
    getAppPaths: vi.fn(),
    getCatalogInfo: vi.fn(),
    getModelFolder: vi.fn(),
    getNetworkActivity: vi.fn(),
    getNetworkState: vi.fn(),
    getStorageInfo: vi.fn(),
    listenNetworkState: vi.fn(),
    listenDownloadProgress: vi.fn(),
    listDownloads: vi.fn(),
    openModelFileFolder: vi.fn(),
    openModelFolder: vi.fn(),
    pauseDownload: vi.fn(),
    resumeDownload: vi.fn(),
    openNetworkDocs: vi.fn(),
    recommendModels: vi.fn(),
    refreshCatalog: vi.fn(),
    resetCatalog: vi.fn(),
    saveHardwareReport: vi.fn(),
    scanHardware: vi.fn(),
    setCatalogRefreshConsent: vi.fn(),
    setOfflineMode: vi.fn(),
    setModelFolder: vi.fn(),
    setSubscribedFamilies: vi.fn(),
    startDownload: vi.fn(),
    APP_INFO: {
      version: metadata.version,
      license: "MIT",
      languages: [
        { code: "en", available: true },
        { code: "hi", available: false },
      ],
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.removeItem("aangan.models.showWontFit");
  const catalogInfo = {
    generated_at: "2026-10-21T13:30:00Z",
    families: ["qwen2.5"],
    subscribed_families: ["qwen2.5"],
    refresh_catalog_always_allowed: false,
    warning: null,
    signature_verified: false,
  };
  vi.mocked(getAppPaths).mockResolvedValue({ data_dir: "C:\\data", data_dir_exists: true });
  vi.mocked(getCatalogInfo).mockResolvedValue(catalogInfo);
  const networkState = {
    offlineMode: false,
    active: 0,
    hosts: [],
    purposes: [],
    bytesDown: 0,
  };
  vi.mocked(getNetworkState).mockResolvedValue(networkState);
  vi.mocked(getStorageInfo).mockResolvedValue({
    modelFolder: "C:\\models",
    modelFiles: [],
    incompleteDownloads: [],
    catalogCacheBytes: 0,
    totalBytes: 0,
  });
  vi.mocked(startDownload).mockImplementation(async (id) => ({
    id,
    state: { kind: "queued" },
    done: 0,
    total: 1024,
    bytesPerSec: 0,
    etaSecs: null,
  }));
  vi.mocked(cancelDownload).mockImplementation(async (id) => ({
    id,
    state: { kind: "cancelled" },
    done: 0,
    total: 1024,
    bytesPerSec: 0,
    etaSecs: null,
  }));
  vi.mocked(pauseDownload).mockImplementation(async (id) => ({
    id,
    state: { kind: "paused" },
    done: 512,
    total: 1024,
    bytesPerSec: 0,
    etaSecs: null,
  }));
  vi.mocked(resumeDownload).mockImplementation(async (id) => ({
    id,
    state: { kind: "queued" },
    done: 512,
    total: 1024,
    bytesPerSec: 0,
    etaSecs: null,
  }));
  vi.mocked(getModelFolder).mockResolvedValue("C:\\models");
  vi.mocked(listDownloads).mockResolvedValue([]);
  vi.mocked(listenDownloadProgress).mockResolvedValue(vi.fn());
  vi.mocked(chooseModelFolder).mockResolvedValue(null);
  vi.mocked(setModelFolder).mockImplementation(async (folder) => folder);
  vi.mocked(deleteStorageFile).mockResolvedValue();
  vi.mocked(openModelFileFolder).mockResolvedValue();
  vi.mocked(openModelFolder).mockResolvedValue();
  vi.mocked(getNetworkActivity).mockResolvedValue([]);
  vi.mocked(listenNetworkState).mockResolvedValue(vi.fn());
  vi.mocked(clearNetworkActivity).mockResolvedValue();
  vi.mocked(openNetworkDocs).mockResolvedValue();
  vi.mocked(setOfflineMode).mockImplementation(async (offlineMode) => ({
    ...networkState,
    offlineMode,
  }));
  vi.mocked(setSubscribedFamilies).mockImplementation(async (families) => ({
    ...catalogInfo,
    subscribed_families: families,
  }));
  vi.mocked(setCatalogRefreshConsent).mockResolvedValue();
  vi.mocked(refreshCatalog).mockResolvedValue({
    generated_at: catalogInfo.generated_at,
    model_count: 7,
    added: 0,
    updated: 0,
  });
  vi.mocked(resetCatalog).mockResolvedValue(catalogInfo);
  vi.mocked(openPath).mockResolvedValue();
  vi.mocked(revealItemInDir).mockResolvedValue();
});

function renderScanView(profile = PRESETS.laptop8_cpu) {
  return render(
    <ToastProvider>
      <ScanView
        profile={profile}
        scanning={false}
        scanError={false}
        onRescan={vi.fn()}
      />
    </ToastProvider>,
  );
}

function renderModelsView(profile: HardwareProfile | null) {
  return render(
    <DownloadsProvider>
      <ToastProvider>
        <TooltipProvider>
          <ModelsView profile={profile} />
        </TooltipProvider>
      </ToastProvider>
    </DownloadsProvider>,
  );
}

function DownloadAttemptHarness() {
  const downloads = useDownloads();
  return (
    <>
      <button onClick={() => void downloads.cancel("model", true)}>Cancel</button>
      <button onClick={() => void downloads.resume("model")}>Resume</button>
      <output>{downloads.byId("model")?.state.kind ?? "missing"}</output>
    </>
  );
}

describe("ModelsView", () => {
  it("does not let a delayed cancel forget a newer resumed attempt", async () => {
    const downloading: DownloadProgress = {
      id: "model",
      state: { kind: "downloading" },
      done: 512,
      total: 1024,
      bytesPerSec: 0,
      etaSecs: null,
    };
    vi.mocked(listDownloads).mockResolvedValue([downloading]);
    let emitProgress: ((next: DownloadProgress) => void) | undefined;
    vi.mocked(listenDownloadProgress).mockImplementation(async (onProgress) => {
      emitProgress = onProgress;
      return () => undefined;
    });
    let resolveCancel: ((progress: DownloadProgress) => void) | undefined;
    vi.mocked(cancelDownload).mockImplementation(() => new Promise((resolve) => {
      resolveCancel = resolve;
    }));
    render(<DownloadsProvider><DownloadAttemptHarness /></DownloadsProvider>);

    await waitFor(() => expect(screen.getByText("downloading")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelDownload).toHaveBeenCalledWith("model", true));
    act(() => {
      emitProgress?.({ ...downloading, state: { kind: "cancelled" } });
    });
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(screen.getByText("queued")).toBeInTheDocument());

    await act(async () => {
      resolveCancel?.({
        ...downloading,
        state: { kind: "cancelled" },
        done: 0,
      });
    });

    expect(screen.getByText("queued")).toBeInTheDocument();
  });

  it("shows the scan-first empty state when no hardware profile exists", () => {
    renderModelsView(null);

    expect(screen.getByText(en.views.models.title)).toBeInTheDocument();
    expect(screen.getByText(en.views.models.empty)).toBeInTheDocument();
  });

  it("loads recommendations and filters cards by searchable model metadata", async () => {
    vi.mocked(recommendModels).mockResolvedValue(
      rankModels(PRESETS.desktop_3060, MODELS, 4096),
    );
    renderModelsView(PRESETS.desktop_3060);

    expect(await screen.findByText("Qwen2.5 7B Instruct")).toBeInTheDocument();
    expect(screen.getByText(en.views.models.catalogSource)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: en.views.models.search }), {
      target: { value: "coding" },
    });
    expect(screen.getByText("Qwen2.5 7B Instruct")).toBeInTheDocument();
    expect(screen.queryByText("Qwen2.5 0.5B Instruct")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: en.views.models.search }), {
      target: { value: "no such model" },
    });
    expect(screen.getByText(en.views.models.noMatch)).toBeInTheDocument();
    expect(recommendModels).toHaveBeenCalledWith(PRESETS.desktop_3060, 4096);
  });

  it("restores measurable progress and exposes pause and resume actions", async () => {
    const recommendations = rankModels(PRESETS.desktop_3060, MODELS, 4096);
    const target = recommendations.find((item) => item.estimate.fit !== "wont_fit");
    if (!target) throw new Error("Expected a fitting model in the test preset.");
    vi.mocked(recommendModels).mockResolvedValue(recommendations);
    const progress: DownloadProgress = {
      id: target.model.id,
      state: { kind: "downloading" },
      done: 1024 ** 2,
      total: 2 * 1024 ** 2,
      bytesPerSec: 512 * 1024,
      etaSecs: 2,
    };
    vi.mocked(listDownloads).mockResolvedValue([progress]);
    let emitProgress: ((next: DownloadProgress) => void) | undefined;
    vi.mocked(listenDownloadProgress).mockImplementation(async (onProgress) => {
      emitProgress = onProgress;
      return () => undefined;
    });
    vi.mocked(pauseDownload).mockImplementation(async (id) => {
      const paused: DownloadProgress = { ...progress, id, state: { kind: "paused" } };
      emitProgress?.(paused);
      return { ...progress, id };
    });
    renderModelsView(PRESETS.desktop_3060);

    const card = await screen.findByRole("group", { name: target.model.name });
    expect(within(card).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    expect(within(card).getByText(en.views.downloads.percent(50))).toBeInTheDocument();
    expect(within(card).getByText(/Estimated .*\/s/)).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: en.views.downloads.pause }));
    await waitFor(() => {
      expect(pauseDownload).toHaveBeenCalledWith(target.model.id);
      expect(within(card).getByRole("button", { name: en.views.downloads.resume })).toBeInTheDocument();
    });
  });

  it("starts a user-selected model download from its recommendation card", async () => {
    const recommendations = rankModels(PRESETS.desktop_3060, MODELS, 4096);
    const target = recommendations.find((item) => item.estimate.fit !== "wont_fit");
    if (!target) throw new Error("Expected a fitting model in the test preset.");
    vi.mocked(recommendModels).mockResolvedValue(recommendations);
    renderModelsView(PRESETS.desktop_3060);

    const card = await screen.findByRole("group", { name: target.model.name });
    fireEvent.click(within(card).getByRole("button", { name: /Download ·/ }));

    await waitFor(() => {
      expect(startDownload).toHaveBeenCalledWith(
        target.model.id,
        PRESETS.desktop_3060,
        4096,
      );
      expect(within(card).getByRole("button", { name: en.views.downloads.pause })).toBeInTheDocument();
    });
  });

  it("deletes and resets a canceled download, ignoring late progress events", async () => {
    const recommendations = rankModels(PRESETS.desktop_3060, MODELS, 4096);
    const target = recommendations.find((item) => item.estimate.fit !== "wont_fit");
    if (!target) throw new Error("Expected a fitting model in the test preset.");
    vi.mocked(recommendModels).mockResolvedValue(recommendations);
    let emitProgress: ((next: DownloadProgress) => void) | undefined;
    vi.mocked(listenDownloadProgress).mockImplementation(async (onProgress) => {
      emitProgress = onProgress;
      return () => undefined;
    });
    vi.mocked(cancelDownload).mockImplementation(async (id) => {
      emitProgress?.({
        id,
        state: { kind: "cancelled" },
        done: 512,
        total: 1024,
        bytesPerSec: 0,
        etaSecs: null,
      });
      return {
        id,
        state: { kind: "cancelled" },
        done: 0,
        total: 1024,
        bytesPerSec: 0,
        etaSecs: null,
      };
    });
    renderModelsView(PRESETS.desktop_3060);

    const card = await screen.findByRole("group", { name: target.model.name });
    fireEvent.click(within(card).getByRole("button", { name: /Download ·/ }));
    fireEvent.click(await within(card).findByRole("button", { name: en.views.downloads.cancel }));

    await waitFor(() => {
      expect(cancelDownload).toHaveBeenCalledWith(target.model.id, true);
      expect(within(card).getByRole("button", { name: /Download ·/ })).toBeInTheDocument();
    });
    emitProgress?.({
      id: target.model.id,
      state: { kind: "cancelled" },
      done: 512,
      total: 1024,
      bytesPerSec: 0,
      etaSecs: null,
    });
    expect(within(card).queryByText(en.views.downloads.cancelled)).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /Download ·/ })).toBeInTheDocument();
  });

  it("keeps Cancel available while a download is verifying", async () => {
    const recommendations = rankModels(PRESETS.desktop_3060, MODELS, 4096);
    const target = recommendations.find((item) => item.estimate.fit !== "wont_fit");
    if (!target) throw new Error("Expected a fitting model in the test preset.");
    vi.mocked(recommendModels).mockResolvedValue(recommendations);
    let emitProgress: ((next: DownloadProgress) => void) | undefined;
    vi.mocked(listenDownloadProgress).mockImplementation(async (onProgress) => {
      emitProgress = onProgress;
      return () => undefined;
    });
    vi.mocked(listDownloads).mockResolvedValue([{
      id: target.model.id,
      state: { kind: "downloading" },
      done: 1024,
      total: 2048,
      bytesPerSec: 0,
      etaSecs: null,
    }]);
    renderModelsView(PRESETS.desktop_3060);

    const card = await screen.findByRole("group", { name: target.model.name });
    await waitFor(() => {
      expect(within(card).getByRole("button", { name: en.views.downloads.pause })).toBeInTheDocument();
    });
    await act(async () => {
      emitProgress?.({
        id: target.model.id,
        state: { kind: "verifying" },
        done: 2048,
        total: 2048,
        bytesPerSec: 0,
        etaSecs: null,
      });
    });

    expect(within(card).queryByRole("button", { name: en.views.downloads.pause })).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: en.views.downloads.cancel }));
    await waitFor(() => expect(cancelDownload).toHaveBeenCalledWith(target.model.id, true));
  });

  it("resumes a canceled partial download instead of creating a duplicate", async () => {
    const recommendations = rankModels(PRESETS.desktop_3060, MODELS, 4096);
    const target = recommendations.find((item) => item.estimate.fit !== "wont_fit");
    if (!target) throw new Error("Expected a fitting model in the test preset.");
    vi.mocked(recommendModels).mockResolvedValue(recommendations);
    vi.mocked(listDownloads).mockResolvedValue([{
      id: target.model.id,
      state: { kind: "cancelled" },
      done: 512,
      total: 1024,
      bytesPerSec: 0,
      etaSecs: null,
    }]);
    renderModelsView(PRESETS.desktop_3060);

    const card = await screen.findByRole("group", { name: target.model.name });
    fireEvent.click(within(card).getByRole("button", { name: en.views.downloads.resume }));

    await waitFor(() => {
      expect(resumeDownload).toHaveBeenCalledWith(target.model.id);
      expect(within(card).getByRole("button", { name: en.views.downloads.pause })).toBeInTheDocument();
    });
  });

  it("does not offer downloads for models marked Won't fit", async () => {
    const recommendations = rankModels(PRESETS.desktop_3060, MODELS, 4096).map((item, index) =>
      index === 0
        ? { ...item, estimate: { ...item.estimate, fit: "wont_fit" as const } }
        : item,
    );
    const target = recommendations[0];
    vi.mocked(recommendModels).mockResolvedValue(recommendations);
    window.localStorage.setItem("aangan.models.showWontFit", "true");
    renderModelsView(PRESETS.desktop_3060);

    const card = await screen.findByRole("group", { name: target.model.name });
    expect(within(card).queryByRole("button", { name: /Download ·/ })).not.toBeInTheDocument();
  });

  it("reveals non-fitting models in a separate section with a keyboard-operable switch", async () => {
    const recommendations = rankModels(PRESETS.desktop_3060, MODELS, 4096).map((item, index) =>
      index === 0
        ? {
            ...item,
            estimate: {
              ...item.estimate,
              fit: "wont_fit" as const,
              placement: { kind: "no_fit" as const },
              memory_required_bytes: 8 * 1024 ** 3,
              reasons: ["reason_no_fit"],
            },
          }
        : { ...item, estimate: { ...item.estimate, fit: "too_slow" as const } },
    );
    vi.mocked(recommendModels).mockResolvedValue(recommendations);
    const { unmount } = renderModelsView(PRESETS.laptop8_cpu);

    expect(await screen.findByText(en.views.models.nothingFits.title)).toBeInTheDocument();
    expect(screen.queryByText(recommendations[0].model.name)).not.toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Show models that won't fit (1)" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    toggle.focus();
    await userEvent.setup().keyboard(" ");
    await waitFor(() =>
      expect(screen.getByText(recommendations[0].model.name)).toBeInTheDocument(),
    );
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(window.localStorage.getItem("aangan.models.showWontFit")).toBe("true");
    expect(screen.getByRole("heading", { name: en.views.models.wontFitTitle })).toBeInTheDocument();
    expect(screen.getByText(/Needs .* — this PC's estimated usable system memory budget is .*\./)).toBeInTheDocument();

    unmount();
    renderModelsView(PRESETS.laptop8_cpu);
    expect(await screen.findByRole("switch", { name: "Show models that won't fit (1)" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("explains when every catalog model fits without adding a zero count", async () => {
    vi.mocked(recommendModels).mockResolvedValue(
      rankModels(PRESETS.desktop_3060, MODELS, 4096).map((item) => ({
        ...item,
        estimate: { ...item.estimate, fit: "good" as const },
      })),
    );
    renderModelsView(PRESETS.desktop_3060);

    expect(await screen.findByText(en.views.models.everyModelFits)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: en.views.models.showWontFit })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("renders a retry action after recommendation failure", async () => {
    vi.mocked(recommendModels)
      .mockRejectedValueOnce(new Error("ranking failed"))
      .mockResolvedValueOnce(rankModels(PRESETS.desktop_3060, MODELS, 4096));
    renderModelsView(PRESETS.desktop_3060);

    expect(await screen.findByText(en.views.models.loadErrorTitle)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.views.models.retry }));
    expect(await screen.findByText("Qwen2.5 7B Instruct")).toBeInTheDocument();
    expect(recommendModels).toHaveBeenCalledTimes(2);
  });

  it("filters recommendations by subscribed families", async () => {
    vi.mocked(getCatalogInfo).mockResolvedValue({
      generated_at: "2026-10-21T13:30:00Z",
      families: ["qwen2.5"],
      subscribed_families: [],
      refresh_catalog_always_allowed: false,
      warning: null,
      signature_verified: false,
    });
    vi.mocked(recommendModels).mockResolvedValue(
      rankModels(PRESETS.desktop_3060, MODELS, 4096),
    );
    renderModelsView(PRESETS.desktop_3060);

    expect(await screen.findByText(en.views.models.noSubscribedFamilies)).toBeInTheDocument();
    expect(screen.queryByText("Qwen2.5 7B Instruct")).not.toBeInTheDocument();
  });

  it("labels catalog models that require gated access", async () => {
    const recommendations = rankModels(PRESETS.desktop_3060, MODELS, 4096);
    recommendations[0].model.tags.push("gated");
    vi.mocked(recommendModels).mockResolvedValue(recommendations);
    renderModelsView(PRESETS.desktop_3060);

    expect(await screen.findByText(en.views.models.gated)).toBeInTheDocument();
  });

  it("asks for consent before refreshing and supports a one-time refresh", async () => {
    vi.mocked(recommendModels).mockResolvedValue(
      rankModels(PRESETS.desktop_3060, MODELS, 4096),
    );
    renderModelsView(PRESETS.desktop_3060);

    fireEvent.click(await screen.findByRole("button", { name: en.views.models.refreshCatalog }));
    expect(await screen.findByText(en.views.models.refreshConsentBody)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.views.models.refreshOnce }));

    expect(await screen.findByText(en.views.models.refreshUpToDate)).toBeInTheDocument();
    expect(refreshCatalog).toHaveBeenCalledWith(true);
    expect(setCatalogRefreshConsent).not.toHaveBeenCalled();
  });

  it("persists the always-allow choice before refreshing", async () => {
    vi.mocked(recommendModels).mockResolvedValue(
      rankModels(PRESETS.desktop_3060, MODELS, 4096),
    );
    renderModelsView(PRESETS.desktop_3060);

    fireEvent.click(await screen.findByRole("button", { name: en.views.models.refreshCatalog }));
    fireEvent.click(await screen.findByRole("button", { name: en.views.models.alwaysAllowRefresh }));

    await waitFor(() => {
      expect(setCatalogRefreshConsent).toHaveBeenCalledWith(true);
      expect(refreshCatalog).toHaveBeenCalledWith(false);
    });
  });

  it("surfaces refresh network failures", async () => {
    vi.mocked(recommendModels).mockResolvedValue(
      rankModels(PRESETS.desktop_3060, MODELS, 4096),
    );
    vi.mocked(refreshCatalog).mockRejectedValueOnce(new Error("network unavailable"));
    renderModelsView(PRESETS.desktop_3060);

    fireEvent.click(await screen.findByRole("button", { name: en.views.models.refreshCatalog }));
    fireEvent.click(screen.getByRole("button", { name: en.views.models.refreshOnce }));
    expect(
      await screen.findByText(en.views.models.refreshFailed("network unavailable")),
    ).toBeInTheDocument();
  });

  it("shows Offline mode refresh failures in a toast", async () => {
    const message = "Offline mode is on. Turn it off in Settings to use the network.";
    vi.mocked(recommendModels).mockResolvedValue(
      rankModels(PRESETS.desktop_3060, MODELS, 4096),
    );
    vi.mocked(refreshCatalog).mockRejectedValueOnce(new Error(message));
    renderModelsView(PRESETS.desktop_3060);

    fireEvent.click(await screen.findByRole("button", { name: en.views.models.refreshCatalog }));
    fireEvent.click(screen.getByRole("button", { name: en.views.models.refreshOnce }));

    expect(await screen.findByRole("status")).toHaveTextContent(message);
    expect(screen.queryByText(en.views.models.refreshFailed(message))).not.toBeInTheDocument();
  });

  it.each([
    ["catalog_signature:untrusted", en.views.models.signatureUntrusted],
    ["catalog_signature:malformed", en.views.models.signatureMalformed],
  ])("shows signature verification failures in a toast", async (error, message) => {
    vi.mocked(recommendModels).mockResolvedValue(
      rankModels(PRESETS.desktop_3060, MODELS, 4096),
    );
    vi.mocked(refreshCatalog).mockRejectedValueOnce(new Error(error));
    renderModelsView(PRESETS.desktop_3060);

    fireEvent.click(await screen.findByRole("button", { name: en.views.models.refreshCatalog }));
    fireEvent.click(screen.getByRole("button", { name: en.views.models.refreshOnce }));

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(message);
  });

  it("keeps refresh success visible if catalog status cannot reload", async () => {
    const catalogInfo = {
      generated_at: "2026-10-21T13:30:00Z",
      families: ["qwen2.5"],
      subscribed_families: ["qwen2.5"],
      refresh_catalog_always_allowed: false,
      warning: null,
      signature_verified: false,
    };
    vi.mocked(getCatalogInfo)
      .mockResolvedValueOnce(catalogInfo)
      .mockRejectedValueOnce(new Error("settings unavailable"));
    vi.mocked(recommendModels).mockResolvedValue(
      rankModels(PRESETS.desktop_3060, MODELS, 4096),
    );
    renderModelsView(PRESETS.desktop_3060);

    fireEvent.click(await screen.findByRole("button", { name: en.views.models.refreshCatalog }));
    fireEvent.click(screen.getByRole("button", { name: en.views.models.refreshOnce }));

    expect(await screen.findByText(en.views.models.refreshUpToDate)).toBeInTheDocument();
    expect(
      await screen.findByText(en.views.models.catalogWarning("settings unavailable")),
    ).toBeInTheDocument();
  });
});

describe("ScanView", () => {
  it("shows the empty state without a profile and the scanning state while probing", () => {
    const onRescan = vi.fn();
    const { rerender } = render(
      <ToastProvider>
        <ScanView profile={null} scanning={false} scanError={false} onRescan={onRescan} />
      </ToastProvider>,
    );
    expect(screen.getByText(en.views.scan.empty)).toBeInTheDocument();

    rerender(
      <ToastProvider>
        <ScanView profile={PRESETS.desktop_3060} scanning scanError onRescan={onRescan} />
      </ToastProvider>,
    );
    expect(screen.getByLabelText(en.views.scan.scanning)).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByText(en.views.scan.scanFailed)).toBeInTheDocument();
  });

  it("renders CPU, integrated GPU, memory, storage and measurement details", () => {
    render(
      <ToastProvider>
        <ScanView
          profile={PRESETS.laptop16_igpu}
          scanning={false}
          scanError={false}
          onRescan={vi.fn()}
        />
      </ToastProvider>,
    );

    expect(screen.getByText(en.views.scan.integratedAlertTitle)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.integratedAlert)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.cpu.avx2)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.integrated)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.notUsedForModels)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.memory.measured)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.storage.title)).toBeInTheDocument();
  });

  it("lists integrated and discrete adapters and suppresses the integrated-only alert", () => {
    const profile = structuredClone(PRESETS.desktop_3060);
    profile.gpus.unshift(structuredClone(PRESETS.laptop16_igpu.gpus[0]));
    renderScanView(profile);

    expect(screen.getByText("Intel Iris Xe Graphics")).toBeInTheDocument();
    expect(screen.getByText("NVIDIA GeForce RTX 3060")).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.vendors.intel)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.vendors.nvidia)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.integrated)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.discrete)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.usedForModels)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.notUsedForModels)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.sharedVram)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.vram)).toBeInTheDocument();
    expect(screen.queryByText(en.views.scan.integratedAlert)).not.toBeInTheDocument();
  });

  it("does not show the built-in graphics alert when no adapter is detected", () => {
    renderScanView(PRESETS.laptop8_cpu);

    expect(screen.queryByText(en.views.scan.integratedAlert)).not.toBeInTheDocument();
  });

  it("shows success feedback after copy and saving the report", async () => {
    vi.mocked(copyHardwareReport).mockResolvedValue();
    vi.mocked(saveHardwareReport).mockResolvedValue("C:\\reports\\report.json");
    renderScanView();
    fireEvent.click(screen.getByRole("button", { name: en.views.scan.copyJson }));
    await waitFor(() =>
      expect(copyHardwareReport).toHaveBeenCalledWith(JSON.stringify(PRESETS.laptop8_cpu, null, 2)),
    );
    expect(await screen.findByText(en.views.scan.reportCopied)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.views.scan.saveFile }));
    expect(await screen.findByText(en.views.scan.reportSaved("C:\\reports\\report.json"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.views.scan.showInFolder }));
    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("C:\\reports\\report.json"));
  });

  it("shows an error toast when saving or copying fails", async () => {
    vi.mocked(copyHardwareReport).mockRejectedValue(new Error("clipboard unavailable"));
    vi.mocked(saveHardwareReport).mockRejectedValue(new Error("disk full"));
    renderScanView();

    fireEvent.click(screen.getByRole("button", { name: en.views.scan.copyJson }));
    expect(await screen.findByText(en.views.scan.copyReportFailed("clipboard unavailable"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.views.scan.saveFile }));
    expect(await screen.findByText(en.views.scan.saveFailed("disk full"))).toBeInTheDocument();
  });

  it("shows no save toast when the dialog is cancelled", async () => {
    vi.mocked(saveHardwareReport).mockResolvedValue(null);
    renderScanView();

    fireEvent.click(screen.getByRole("button", { name: en.views.scan.saveFile }));
    await waitFor(() => expect(saveHardwareReport).toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("DownloadsDrawer", () => {
  it("shows active progress, a folder destination, and the active-count badge", async () => {
    vi.mocked(listDownloads).mockResolvedValue([{
      id: "qwen2.5-0.5b-instruct-q4_k_m",
      state: { kind: "downloading" },
      done: 1024,
      total: 2048,
      bytesPerSec: 512,
      etaSecs: 2,
    }]);
    const { unmount } = render(
      <DownloadsProvider>
        <DownloadsButton onClick={vi.fn()} />
      </DownloadsProvider>,
    );
    expect(await screen.findByRole("button", {
      name: `Downloads, ${en.views.downloads.activeCount(1)}`,
    })).toBeInTheDocument();
    unmount();

    render(
      <DownloadsProvider>
        <ToastProvider>
          <DownloadsDrawer
            open
            onOpenChange={vi.fn()}
            profile={PRESETS.desktop_3060}
          />
        </ToastProvider>
      </DownloadsProvider>,
    );

    expect(await screen.findByText(en.views.downloads.savedTo("C:\\models"))).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    fireEvent.click(screen.getByRole("button", { name: en.views.downloads.openFolder }));
    await waitFor(() => expect(openModelFolder).toHaveBeenCalled());
  });
});

describe("SettingsView and FirstRunWizard", () => {
  it("changes the model folder through the native folder picker", async () => {
    vi.mocked(chooseModelFolder).mockResolvedValue("C:\\LocalModels");
    vi.mocked(setModelFolder).mockResolvedValue("C:\\LocalModels");
    vi.mocked(getStorageInfo)
      .mockResolvedValueOnce({
        modelFolder: "C:\\models",
        modelFiles: [],
        incompleteDownloads: [],
        catalogCacheBytes: 0,
        totalBytes: 0,
      })
      .mockResolvedValueOnce({
        modelFolder: "C:\\LocalModels",
        modelFiles: [{
          path: "C:\\LocalModels\\small.gguf",
          name: "small.gguf",
          sizeBytes: 1024,
          modelId: "small-model",
        }],
        incompleteDownloads: [],
        catalogCacheBytes: 0,
        totalBytes: 1024,
      });
    render(<ToastProvider><SettingsView /></ToastProvider>);

    fireEvent.click(await screen.findByRole("button", { name: en.views.settings.storage.chooseFolder }));
    expect(await screen.findByText("C:\\LocalModels")).toBeInTheDocument();
    expect(await screen.findByText("small.gguf")).toBeInTheDocument();
    expect(setModelFolder).toHaveBeenCalledWith("C:\\LocalModels");
    expect(getStorageInfo).toHaveBeenCalledTimes(2);
  });

  it("retries loading storage after an initial error", async () => {
    vi.mocked(getStorageInfo)
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce({
        modelFolder: "C:\\recovered",
        modelFiles: [],
        incompleteDownloads: [],
        catalogCacheBytes: 0,
        totalBytes: 0,
      });
    render(<ToastProvider><SettingsView /></ToastProvider>);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      en.views.settings.storage.loadFailed("storage unavailable"),
    );
    fireEvent.click(screen.getByRole("button", { name: en.views.settings.storage.retry }));

    expect(await screen.findByText("C:\\recovered")).toBeInTheDocument();
    expect(getStorageInfo).toHaveBeenCalledTimes(2);
  });

  it("refreshes storage inventory after a model download completes", async () => {
    vi.mocked(getStorageInfo)
      .mockResolvedValueOnce({
        modelFolder: "C:\\models",
        modelFiles: [],
        incompleteDownloads: [],
        catalogCacheBytes: 0,
        totalBytes: 0,
      })
      .mockResolvedValueOnce({
        modelFolder: "C:\\models",
        modelFiles: [{
          path: "C:\\models\\family\\small.gguf",
          name: "small.gguf",
          sizeBytes: 1024,
          modelId: "small-model",
        }],
        incompleteDownloads: [],
        catalogCacheBytes: 0,
        totalBytes: 1024,
      });
    render(<ToastProvider><SettingsView /></ToastProvider>);

    expect(await screen.findByText(en.views.settings.storage.emptyModels)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.views.settings.storage.refresh }));

    expect(await screen.findByText("C:\\models\\family\\small.gguf")).toBeInTheDocument();
    expect(getStorageInfo).toHaveBeenCalledTimes(2);
  });

  it("ignores an outdated storage refresh after changing folders", async () => {
    const originalInfo: StorageInfo = {
      modelFolder: "C:\\models",
      modelFiles: [{
        path: "C:\\models\\small.gguf",
        name: "small.gguf",
        sizeBytes: 1024,
        modelId: "small-model",
      }],
      incompleteDownloads: [],
      catalogCacheBytes: 0,
      totalBytes: 1024,
    };
    const updatedInfo: StorageInfo = {
      modelFolder: "C:\\LocalModels",
      modelFiles: [{
        path: "C:\\LocalModels\\new.gguf",
        name: "new.gguf",
        sizeBytes: 2048,
        modelId: "new-model",
      }],
      incompleteDownloads: [],
      catalogCacheBytes: 0,
      totalBytes: 2048,
    };
    let resolveStaleInfo: ((info: StorageInfo) => void) | undefined;
    vi.mocked(getStorageInfo)
      .mockResolvedValueOnce(originalInfo)
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveStaleInfo = resolve;
      }))
      .mockResolvedValueOnce(updatedInfo);
    vi.mocked(chooseModelFolder).mockResolvedValue("C:\\LocalModels");
    render(<ToastProvider><SettingsView /></ToastProvider>);

    fireEvent.click(await screen.findByRole("button", { name: en.views.settings.storage.delete }));
    fireEvent.click(screen.getByRole("button", { name: en.views.settings.storage.confirmDelete }));
    await waitFor(() => expect(resolveStaleInfo).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: en.views.settings.storage.chooseFolder }));
    expect(await screen.findByText("new.gguf")).toBeInTheDocument();
    expect(screen.getByText("C:\\LocalModels")).toBeInTheDocument();
    resolveStaleInfo?.(originalInfo);
    await waitFor(() => expect(getStorageInfo).toHaveBeenCalledTimes(3));
    expect(screen.getByText("C:\\LocalModels")).toBeInTheDocument();
    expect(screen.queryByText("C:\\models")).not.toBeInTheDocument();
  });

  it("confirms storage deletion and removes the download from the shared list", async () => {
    vi.mocked(getStorageInfo).mockResolvedValue({
      modelFolder: "C:\\models",
      modelFiles: [
        {
          path: "C:\\models\\family-a\\small.gguf",
          name: "small.gguf",
          sizeBytes: 1024,
          modelId: "small-model-a",
        },
        {
          path: "C:\\models\\family-b\\small.gguf",
          name: "small.gguf",
          sizeBytes: 2048,
          modelId: "small-model-b",
        },
      ],
      incompleteDownloads: [],
      catalogCacheBytes: 0,
      totalBytes: 3072,
    });
    const onDownloadDeleted = vi.fn();
    render(<ToastProvider><SettingsView onDownloadDeleted={onDownloadDeleted} /></ToastProvider>);

    const firstPath = await screen.findByText("C:\\models\\family-a\\small.gguf");
    expect(screen.getByText("C:\\models\\family-b\\small.gguf")).toBeInTheDocument();
    const firstFileRow = firstPath.closest("li");
    if (!firstFileRow) throw new Error("Expected the first Storage file row.");
    fireEvent.click(within(firstFileRow).getByRole("button", { name: en.views.settings.storage.delete }));
    expect(await screen.findByText(en.views.settings.storage.deleteDescription(
      "small.gguf",
      "C:\\models\\family-a\\small.gguf",
    ))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.views.settings.storage.confirmDelete }));

    await waitFor(() => {
      expect(deleteStorageFile).toHaveBeenCalledWith(
        "C:\\models\\family-a\\small.gguf",
        "small-model-a",
      );
      expect(onDownloadDeleted).toHaveBeenCalledWith("small-model-a");
    });
  });

  it("renders the real data path and supports open and copy actions", async () => {
    const dataDir = "C:\\Users\\partv\\AppData\\Local\\Aangan";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.mocked(getAppPaths).mockResolvedValue({ data_dir: dataDir, data_dir_exists: true });
    render(<ToastProvider><SettingsView /></ToastProvider>);

    expect(await screen.findByText(dataDir)).toBeInTheDocument();
    expect(screen.getByText(en.views.settings.privacy.title)).toBeInTheDocument();
    expect(screen.getByText(en.views.settings.catalog.source)).toBeInTheDocument();
    expect(screen.getByText(en.views.settings.language.options.hi)).toBeInTheDocument();
    expect(screen.getByText(packageMetadata.version)).toBeInTheDocument();
    expect(screen.getByText(en.views.settings.about.notices)).toBeInTheDocument();
    expect(screen.getByText(en.views.settings.data.hint)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: en.views.settings.data.openFolder }));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith(dataDir));
    fireEvent.click(screen.getByRole("button", { name: en.views.settings.data.copyPath }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(dataDir));
    expect(await screen.findByText(en.views.settings.data.copied)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.views.settings.about.notices }));
    expect(
      await screen.findByRole(
        "heading",
        { name: "Aangan" },
        { timeout: 10_000 },
      ),
    ).toBeInTheDocument();
  });

  it("labels an active refreshed catalog as signature-verified", async () => {
    vi.mocked(getCatalogInfo).mockResolvedValue({
      generated_at: "2026-10-22T13:30:00Z",
      families: ["qwen2.5"],
      subscribed_families: ["qwen2.5"],
      refresh_catalog_always_allowed: false,
      warning: null,
      signature_verified: true,
    });
    render(<ToastProvider><SettingsView /></ToastProvider>);

    expect(
      await screen.findByText(/Catalog generated .*Signature: verified/),
    ).toBeInTheDocument();
  });

  it("shows network activity and saves the Offline mode preference", async () => {
    const activity = {
      id: 1,
      startedMs: Date.parse("2026-10-22T13:30:00Z"),
      purpose: "catalog" as const,
      host: "raw.githubusercontent.com",
      via: null,
      bytesDown: 128,
      ok: true,
      note: "ok",
    };
    vi.mocked(getNetworkActivity).mockResolvedValue([activity]);
    vi.mocked(setOfflineMode).mockResolvedValue({
      offlineMode: true,
      active: 0,
      hosts: [],
      purposes: [],
      bytesDown: 0,
    });
    render(<ToastProvider><SettingsView /></ToastProvider>);

    const offlineCheckbox = await screen.findByRole("checkbox", { name: /Offline mode/ });
    expect(offlineCheckbox).not.toBeChecked();
    fireEvent.click(offlineCheckbox);
    await waitFor(() => expect(setOfflineMode).toHaveBeenCalledWith(true));
    await waitFor(() => expect(offlineCheckbox).toBeChecked());

    fireEvent.click(await screen.findByRole("button", { name: en.views.settings.network.seeActivity }));
    expect(await screen.findByText("raw.githubusercontent.com")).toBeInTheDocument();
    expect(screen.getByText("Model list")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.views.settings.network.clearActivity }));
    await waitFor(() => expect(clearNetworkActivity).toHaveBeenCalledOnce());
  });

  it("opens network documentation from Privacy settings", async () => {
    render(<ToastProvider><SettingsView /></ToastProvider>);

    fireEvent.click(await screen.findByRole("button", { name: en.views.settings.privacy.networkDetails }));

    await waitFor(() => expect(openNetworkDocs).toHaveBeenCalledOnce());
  });

  it("shows the full retained network activity list on the Activity page", async () => {
    const records = Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      startedMs: Date.parse("2026-10-22T13:30:00Z") + index,
      purpose: "catalog" as const,
      host: `host-${index + 1}.example`,
      via: null,
      bytesDown: 128,
      ok: true,
      note: "ok",
    }));
    vi.mocked(getNetworkActivity).mockResolvedValue(records);
    render(<ToastProvider><SettingsView /></ToastProvider>);

    fireEvent.click(await screen.findByRole("button", { name: en.views.settings.network.seeActivity }));

    expect(await screen.findByText("host-12.example")).toBeInTheDocument();
    expect(screen.getByText("host-1.example")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("updates active network status from gate events", async () => {
    const activeState = {
      offlineMode: false,
      active: 1,
      hosts: ["raw.githubusercontent.com"],
      purposes: ["catalog" as const],
      bytesDown: 64,
    };
    vi.mocked(listenNetworkState).mockImplementation(async (onState) => {
      onState(activeState);
      return () => undefined;
    });
    render(<ToastProvider><SettingsView /></ToastProvider>);

    expect(await screen.findByText(en.views.settings.network.activeRequests(1))).toBeInTheDocument();
    expect(
      screen.getByText(en.views.settings.network.activeHosts("raw.githubusercontent.com")),
    ).toBeInTheDocument();
  });

  it("applies and persists appearance choices", () => {
    window.localStorage.removeItem("aangan.theme");
    document.documentElement.removeAttribute("data-theme");
    render(<ToastProvider><SettingsView /></ToastProvider>);

    expect(screen.getByText(en.views.settings.appearance.description)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: en.views.settings.appearance.options.dark }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("aangan.theme")).toBe("dark");

    fireEvent.click(screen.getByRole("radio", { name: en.views.settings.appearance.options.light }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("aangan.theme")).toBe("light");
  });

  it("shows an explicit loading skeleton while reading the data path", () => {
    vi.mocked(getAppPaths).mockReturnValue(new Promise(() => {}));
    render(<ToastProvider><SettingsView /></ToastProvider>);
    expect(screen.getByRole("status", { name: en.views.settings.data.loading })).toBeInTheDocument();
  });

  it("shows an explicit data-path error", async () => {
    vi.mocked(getAppPaths).mockRejectedValue(new Error("path access denied"));
    render(<ToastProvider><SettingsView /></ToastProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't read the data folder: path access denied",
    );
  });

  it("saves model-family subscriptions and resets the catalog", async () => {
    vi.mocked(getAppPaths).mockResolvedValue({ data_dir: "C:\\data", data_dir_exists: true });
    render(<ToastProvider><SettingsView /></ToastProvider>);

    const familyCheckbox = await screen.findByRole("checkbox", { name: "qwen2.5" });
    fireEvent.click(familyCheckbox);
    await waitFor(() => expect(setSubscribedFamilies).toHaveBeenCalledWith([]));

    fireEvent.click(screen.getByRole("checkbox", { name: en.views.settings.catalog.alwaysAllow }));
    await waitFor(() => expect(setCatalogRefreshConsent).toHaveBeenCalledWith(true));

    fireEvent.click(screen.getByRole("button", { name: en.views.settings.catalog.reset }));
    expect(await screen.findByText(en.views.settings.catalog.resetComplete)).toBeInTheDocument();
    expect(resetCatalog).toHaveBeenCalledOnce();
  });

  it("reports failures when saving catalog preferences or resetting the cache", async () => {
    vi.mocked(getAppPaths).mockResolvedValue({ data_dir: "C:\\data", data_dir_exists: true });
    vi.mocked(setSubscribedFamilies).mockRejectedValueOnce(new Error("family write failed"));
    vi.mocked(setCatalogRefreshConsent).mockRejectedValueOnce(new Error("consent write failed"));
    vi.mocked(resetCatalog).mockRejectedValueOnce(new Error("cache reset failed"));
    render(<ToastProvider><SettingsView /></ToastProvider>);

    fireEvent.click(await screen.findByRole("checkbox", { name: "qwen2.5" }));
    expect(
      await screen.findByText(en.views.settings.catalog.saveFailed("family write failed")),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: en.views.settings.catalog.alwaysAllow }));
    expect(
      await screen.findByText(en.views.settings.catalog.saveFailed("consent write failed")),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: en.views.settings.catalog.reset }));
    expect(
      await screen.findByText(en.views.settings.catalog.resetFailed("cache reset failed")),
    ).toBeInTheDocument();
  });

  it("completes first-run scanning and reports the selected bandwidth option", async () => {
    vi.mocked(scanHardware).mockResolvedValue(PRESETS.desktop_3060);
    const onComplete = vi.fn();
    render(<FirstRunWizard onComplete={onComplete} />);

    fireEvent.click(screen.getByRole("button", { name: en.wizard.welcome.cta }));
    expect(scanHardware).toHaveBeenCalledWith(true);
    expect(await screen.findByText(en.wizard.done.title)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.wizard.done.cta }));

    expect(onComplete).toHaveBeenCalledWith(PRESETS.desktop_3060, true);
  });

  it("shows scan errors and can copy diagnostic details", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.mocked(scanHardware).mockRejectedValue(new Error("probe failed"));
    render(<FirstRunWizard onComplete={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: en.wizard.welcome.cta }));
    expect(await screen.findByText(en.wizard.error.title)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.wizard.error.copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toContain('"kind": "scan_failed"');
  });
});

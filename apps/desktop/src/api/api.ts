import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getDevPreset, getFailScans } from "./devPreset";
import { rankModels } from "./estimate";
import { APP_INFO, MODELS, PRESETS } from "./presets";
import type {
  AppPaths,
  CatalogInfo,
  CatalogRefreshResult,
  DownloadProgress,
  HardwareProfile,
  NetworkActivity,
  NetworkState,
  Recommendation,
  StorageInfo,
} from "./types";

export { APP_INFO };

const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const DELAY_MS = 1500;
const BANDWIDTH_EXTRA_MS = 2000;
const OFFLINE_MODE_KEY = "aangan.network.offlineMode";
const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function scanHardware(
  measureBandwidth = false,
): Promise<HardwareProfile> {
  if (!inTauri) {
    await wait(measureBandwidth ? DELAY_MS + BANDWIDTH_EXTRA_MS : DELAY_MS);
    if (getFailScans()) {
      throw new Error("mock_scan_failed: could not read GPU adapters (DXGI)");
    }

    const profile = structuredClone(PRESETS[getDevPreset()]);
    if (!measureBandwidth) {
      profile.memory.read_bandwidth_gbps = null;
      profile.memory.bandwidth_source = "not_measured";
    }
    return profile;
  }

  return invoke<HardwareProfile>("scan_hardware", { measureBandwidth });
}

export async function recommendModels(
  profile: HardwareProfile,
  context: number,
): Promise<Recommendation[]> {
  if (!inTauri) {
    await wait(DELAY_MS);
    return rankModels(profile, MODELS, context);
  }

  return invoke<Recommendation[]>("recommend_models", { profile, context });
}

export async function getAppPaths(): Promise<AppPaths> {
  return invoke<AppPaths>("get_app_paths");
}

export async function openAanganRepository(): Promise<void> {
  return invoke<void>("open_aangan_repository");
}

export async function openThirdPartyNotices(): Promise<void> {
  return invoke<void>("open_third_party_notices");
}

export async function getCatalogInfo(): Promise<CatalogInfo> {
  if (!inTauri) {
    const stored = window.localStorage.getItem("aangan.catalog.subscribedFamilies");
    const families = [...new Set(MODELS.map((model) => model.family))];
    const selected = stored ? JSON.parse(stored) as string[] : families;
    return {
      generated_at: "2026-10-21T13:30:00Z",
      families,
      subscribed_families: selected.filter((family) => families.includes(family)),
      refresh_catalog_always_allowed:
        window.localStorage.getItem("aangan.catalog.refreshAlwaysAllowed") === "true",
      warning: null,
      signature_verified: false,
    };
  }
  return invoke<CatalogInfo>("get_catalog_info");
}

export async function setSubscribedFamilies(families: string[]): Promise<CatalogInfo> {
  if (!inTauri) {
    window.localStorage.setItem("aangan.catalog.subscribedFamilies", JSON.stringify(families));
    return getCatalogInfo();
  }
  return invoke<CatalogInfo>("set_subscribed_families", { families });
}

export async function setCatalogRefreshConsent(alwaysAllowed: boolean): Promise<void> {
  if (!inTauri) {
    window.localStorage.setItem("aangan.catalog.refreshAlwaysAllowed", String(alwaysAllowed));
    return;
  }
  return invoke<void>("set_catalog_refresh_consent", { alwaysAllowed });
}

export async function resetCatalog(): Promise<CatalogInfo> {
  if (!inTauri) return getCatalogInfo();
  return invoke<CatalogInfo>("reset_catalog");
}

export async function refreshCatalog(consentOnce: boolean): Promise<CatalogRefreshResult> {
  if (!inTauri) {
    throw new Error("Catalog refresh is available only in the desktop app.");
  }
  return invoke<CatalogRefreshResult>("refresh_catalog", { consentOnce });
}

export async function listDownloads(): Promise<DownloadProgress[]> {
  if (!inTauri) return [];
  return invoke<DownloadProgress[]>("downloads_list");
}

export async function listenDownloadProgress(
  onProgress: (progress: DownloadProgress) => void,
): Promise<UnlistenFn> {
  if (!inTauri) return () => {};
  return listen<DownloadProgress>("downloads://progress", (event) => onProgress(event.payload));
}

export async function startDownload(
  modelId: string,
  profile: HardwareProfile,
  context: number,
): Promise<DownloadProgress> {
  if (!inTauri) {
    throw new Error("Model downloads are available only in the desktop app.");
  }
  return invoke<DownloadProgress>("download_model", { modelId, profile, context });
}

export async function pauseDownload(id: string): Promise<DownloadProgress> {
  if (!inTauri) throw new Error("Model downloads are available only in the desktop app.");
  return invoke<DownloadProgress>("download_pause", { id });
}

export async function resumeDownload(id: string): Promise<DownloadProgress> {
  if (!inTauri) throw new Error("Model downloads are available only in the desktop app.");
  return invoke<DownloadProgress>("download_resume", { id });
}

export async function cancelDownload(
  id: string,
  deletePartial: boolean,
): Promise<DownloadProgress> {
  if (!inTauri) throw new Error("Model downloads are available only in the desktop app.");
  return invoke<DownloadProgress>("download_cancel", { id, deletePartial });
}

export async function getModelFolder(): Promise<string> {
  if (!inTauri) throw new Error("Model storage settings are available only in the desktop app.");
  return invoke<string>("get_model_folder");
}

export async function chooseModelFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export async function setModelFolder(folder: string): Promise<string> {
  if (!inTauri) throw new Error("Model storage settings are available only in the desktop app.");
  return invoke<string>("set_model_folder", { folder });
}

export async function openModelFolder(): Promise<void> {
  if (!inTauri) throw new Error("Model storage settings are available only in the desktop app.");
  return invoke<void>("open_model_folder");
}

export async function getStorageInfo(): Promise<StorageInfo> {
  if (!inTauri) throw new Error("Model storage is available only in the desktop app.");
  return invoke<StorageInfo>("get_storage_info");
}

export async function deleteStorageFile(
  path: string,
  modelId: string | null,
): Promise<void> {
  if (!inTauri) throw new Error("Model storage is available only in the desktop app.");
  return invoke<void>("delete_storage_file", { path, modelId });
}

export async function openModelFileFolder(path: string): Promise<void> {
  if (!inTauri) throw new Error("Model storage is available only in the desktop app.");
  return invoke<void>("open_model_file_folder", { path });
}

export async function openNetworkDocs(): Promise<void> {
  if (!inTauri) {
    throw new Error("Network access details are available only in the desktop app.");
  }
  return invoke<void>("open_network_docs");
}

export async function getNetworkState(): Promise<NetworkState> {
  if (!inTauri) {
    return {
      offlineMode: window.localStorage.getItem(OFFLINE_MODE_KEY) === "true",
      active: 0,
      hosts: [],
      purposes: [],
      bytesDown: 0,
    };
  }
  return invoke<NetworkState>("get_network_state");
}

export async function getNetworkActivity(): Promise<NetworkActivity[]> {
  if (!inTauri) return [];
  return invoke<NetworkActivity[]>("get_network_activity");
}

export async function clearNetworkActivity(): Promise<void> {
  if (!inTauri) return;
  return invoke<void>("clear_network_activity");
}

export async function setOfflineMode(offlineMode: boolean): Promise<NetworkState> {
  if (!inTauri) {
    window.localStorage.setItem(OFFLINE_MODE_KEY, String(offlineMode));
    return getNetworkState();
  }
  return invoke<NetworkState>("set_offline_mode", { offlineMode });
}

export async function listenNetworkState(
  onState: (state: NetworkState) => void,
): Promise<UnlistenFn> {
  if (!inTauri) return () => {};
  return listen<NetworkState>("network://state", (event) => onState(event.payload));
}

export async function saveHardwareReport(
  contents: string,
): Promise<string | null> {
  const path = await save({
    defaultPath: `aangan-hardware-report-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (path === null) return null;

  const saved = await invoke<{ path: string; bytes: number }>(
    "save_text_file",
    { path, contents },
  );
  return saved.path;
}

export async function copyHardwareReport(contents: string): Promise<void> {
  await navigator.clipboard.writeText(contents);
}

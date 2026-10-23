import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { getDevPreset, getFailScans } from "./devPreset";
import { rankModels } from "./estimate";
import { APP_INFO, MODELS, PRESETS } from "./presets";
import type {
  AppPaths,
  CatalogInfo,
  CatalogRefreshResult,
  HardwareProfile,
  Recommendation,
} from "./types";

export { APP_INFO };

const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const DELAY_MS = 1500;
const BANDWIDTH_EXTRA_MS = 2000;
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

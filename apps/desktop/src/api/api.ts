import { invoke } from "@tauri-apps/api/core";
import { getDevPreset, getFailScans } from "./devPreset";
import { rankModels } from "./estimate";
import { APP_INFO, MODELS, PRESETS } from "./presets";
import type { HardwareProfile, Recommendation } from "./types";

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

import { PRESET_IDS, type PresetId } from "./presets";

const KEY = "aangan.devPreset";
let current: PresetId = "desktop_3060";
let failScans = false;

if (typeof window !== "undefined") {
  const saved = window.localStorage.getItem(KEY) as PresetId | null;
  if (saved && PRESET_IDS.includes(saved)) current = saved;
}

export function getDevPreset(): PresetId {
  return current;
}

export function setDevPreset(id: PresetId): void {
  current = id;
  if (typeof window !== "undefined") window.localStorage.setItem(KEY, id);
}

/** Dev-only: make scanHardware reject, to exercise the error state. */
export function getFailScans(): boolean {
  return failScans;
}

export function setFailScans(v: boolean): void {
  failScans = v;
}

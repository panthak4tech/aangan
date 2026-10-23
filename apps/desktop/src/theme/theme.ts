import { isTauri } from "@tauri-apps/api/core";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "aangan.theme";
export const DEFAULT_THEME: Theme = "system";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

export function resolveTheme(theme: Theme, systemPrefersDark: boolean): ResolvedTheme {
  if (theme === "system") return systemPrefersDark ? "dark" : "light";
  return theme;
}

function getStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredTheme(
  storage: Pick<Storage, "getItem"> | null = getStorage(),
): Theme {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function storeTheme(
  theme: Theme,
  storage: Pick<Storage, "setItem"> | null = getStorage(),
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    console.warn("Unable to persist the appearance preference.");
  }
}

let stopWatching: (() => void) | null = null;

function paint(doc: Document, resolved: ResolvedTheme): void {
  doc.documentElement.dataset.theme = resolved;
  const bg = doc.defaultView
    ?.getComputedStyle(doc.documentElement)
    .getPropertyValue("--color-bg")
    .trim();
  if (bg) doc.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
}

async function syncNativeWindow(theme: Theme): Promise<void> {
  if (!isTauri()) return;

  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTheme(theme === "system" ? null : theme);
  } catch (error) {
    console.error("Unable to sync the native window theme.", error);
  }
}

export function applyTheme(
  theme: Theme,
  doc: Document = document,
  win: Window = window,
): ResolvedTheme {
  stopWatching?.();
  stopWatching = null;

  const mql = typeof win.matchMedia === "function" ? win.matchMedia(DARK_QUERY) : null;
  const resolved = resolveTheme(theme, mql?.matches ?? false);
  paint(doc, resolved);

  if (theme === "system" && mql) {
    const onChange = (event: MediaQueryListEvent) =>
      paint(doc, event.matches ? "dark" : "light");
    mql.addEventListener("change", onChange);
    stopWatching = () => mql.removeEventListener("change", onChange);
  }

  void syncNativeWindow(theme);
  return resolved;
}

export function initTheme(): Theme {
  const theme = readStoredTheme();
  applyTheme(theme);
  return theme;
}

export function setTheme(theme: Theme): void {
  storeTheme(theme);
  applyTheme(theme);
}

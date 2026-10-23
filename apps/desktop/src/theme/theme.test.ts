import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  applyTheme,
  initTheme,
  isTheme,
  readStoredTheme,
  resolveTheme,
  setTheme,
} from "./theme";

const tauriMocks = vi.hoisted(() => ({
  isTauri: vi.fn<() => boolean>(),
  getCurrentWindow: vi.fn<() => { setTheme: (theme: "light" | "dark" | null) => Promise<void> }>(),
  setTheme: vi.fn<(theme: "light" | "dark" | null) => Promise<void>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: tauriMocks.isTauri }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: tauriMocks.getCurrentWindow }));

type ThemeChangeListener = (event: MediaQueryListEvent) => void;

function fakeWindow(initialDark: boolean) {
  const listeners = new Set<ThemeChangeListener>();
  const mediaQuery = {
    matches: initialDark,
    addEventListener: (_event: string, callback: ThemeChangeListener) => listeners.add(callback),
    removeEventListener: (_event: string, callback: ThemeChangeListener) =>
      listeners.delete(callback),
  };
  const win = { matchMedia: () => mediaQuery } as unknown as Window;

  return {
    win,
    emit(dark: boolean) {
      mediaQuery.matches = dark;
      listeners.forEach((listener) => listener({ matches: dark } as MediaQueryListEvent));
    },
    count: () => listeners.size,
  };
}

const resolvedTheme = () => document.documentElement.dataset.theme;

beforeEach(() => {
  vi.clearAllMocks();
  tauriMocks.isTauri.mockReturnValue(false);
  tauriMocks.getCurrentWindow.mockReturnValue({ setTheme: tauriMocks.setTheme });
  tauriMocks.setTheme.mockResolvedValue();
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear();
});

describe("resolveTheme and isTheme", () => {
  it("resolves system preference and preserves explicit choices", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("validates theme values", () => {
    expect(isTheme("dark")).toBe(true);
    expect(isTheme("purple")).toBe(false);
    expect(isTheme(null)).toBe(false);
  });
});

describe("readStoredTheme", () => {
  it("uses the default for missing, invalid, or unreadable storage", () => {
    expect(readStoredTheme(null)).toBe(DEFAULT_THEME);
    expect(readStoredTheme({ getItem: () => "invalid" })).toBe(DEFAULT_THEME);
    expect(readStoredTheme({ getItem: () => { throw new Error("storage denied"); } })).toBe(
      DEFAULT_THEME,
    );
  });

  it("returns a valid stored preference", () => {
    expect(readStoredTheme({ getItem: () => "dark" })).toBe("dark");
  });
});

describe("applyTheme", () => {
  it("applies explicit light and dark choices regardless of system preference", () => {
    expect(applyTheme("dark", document, fakeWindow(false).win)).toBe("dark");
    expect(resolvedTheme()).toBe("dark");
    expect(applyTheme("light", document, fakeWindow(true).win)).toBe("light");
    expect(resolvedTheme()).toBe("light");
  });

  it("follows system changes", () => {
    const system = fakeWindow(true);
    applyTheme("system", document, system.win);
    expect(resolvedTheme()).toBe("dark");
    system.emit(false);
    expect(resolvedTheme()).toBe("light");
    system.emit(true);
    expect(resolvedTheme()).toBe("dark");
  });

  it("removes the system listener after a fixed theme is selected", () => {
    const system = fakeWindow(false);
    applyTheme("system", document, system.win);
    expect(system.count()).toBe(1);
    applyTheme("light", document, system.win);
    expect(system.count()).toBe(0);
  });

  it("updates the browser theme-color from the active background token", () => {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
    document.documentElement.style.setProperty("--color-bg", "#123456");

    applyTheme("dark", document, fakeWindow(false).win);

    expect(meta.content).toBe("#123456");
    meta.remove();
    document.documentElement.style.removeProperty("--color-bg");
  });
});

describe("initTheme", () => {
  it("applies the saved theme before returning", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

    expect(initTheme()).toBe("dark");
    expect(resolvedTheme()).toBe("dark");
  });
});

describe("setTheme", () => {
  it("persists and applies the selected preference", () => {
    setTheme("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(resolvedTheme()).toBe("dark");
  });
});

describe("native window theme synchronization", () => {
  it.each([
    { theme: "light" as const, nativeTheme: "light" as const },
    { theme: "dark" as const, nativeTheme: "dark" as const },
    { theme: "system" as const, nativeTheme: null },
  ])("maps $theme to the native $nativeTheme theme", async ({ theme, nativeTheme }) => {
    tauriMocks.isTauri.mockReturnValue(true);

    applyTheme(theme);

    await vi.waitFor(() => expect(tauriMocks.setTheme).toHaveBeenCalledWith(nativeTheme));
    expect(tauriMocks.getCurrentWindow).toHaveBeenCalledOnce();
  });

  it("logs native theme errors without throwing", async () => {
    const error = new Error("native theme rejected");
    tauriMocks.isTauri.mockReturnValue(true);
    tauriMocks.setTheme.mockRejectedValue(error);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => applyTheme("dark")).not.toThrow();
    await vi.waitFor(() =>
      expect(errorLog).toHaveBeenCalledWith("Unable to sync the native window theme.", error),
    );

    errorLog.mockRestore();
  });
});

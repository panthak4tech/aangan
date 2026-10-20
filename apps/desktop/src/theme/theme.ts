export type Theme = "light" | "dark" | "system";

export function applyTheme(theme: Theme): void {
  if (theme === "dark") {
    // TODO(night-mode): apply dark token overrides when they are implemented.
  }

  document.documentElement.dataset.theme = "light";
}

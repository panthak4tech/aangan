import { useState } from "react";
import { readStoredTheme, setTheme as persistAndApplyTheme } from "./theme";
import type { Theme } from "./theme";

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setSelectedTheme] = useState<Theme>(() => readStoredTheme());

  const updateTheme = (nextTheme: Theme) => {
    setSelectedTheme(nextTheme);
    persistAndApplyTheme(nextTheme);
  };

  return [theme, updateTheme];
}

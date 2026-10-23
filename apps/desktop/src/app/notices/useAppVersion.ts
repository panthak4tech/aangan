import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";

/** Returns the running app's version (from Tauri), or null while loading. */
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getVersion()
      .then((value) => {
        if (active) setVersion(value);
      })
      .catch(() => {
        if (active) setVersion("unknown");
      });
    return () => {
      active = false;
    };
  }, []);

  return version;
}

import type { HardwareProfile } from "@/api/types";
import { en } from "@/i18n/en";

const GB = 1024 ** 3;

/** Plain-language one-liner, e.g. "We found 16 GB memory and an NVIDIA GeForce RTX 3060". */
export function summarizeProfile(p: HardwareProfile): string {
  const memGb = Math.round(p.memory.total_bytes / GB);
  const dedicated = p.gpus.find((g) => !g.is_integrated);
  const integrated = p.gpus.find((g) => g.is_integrated);
  const s = en.wizard.done;
  if (dedicated) return s.summaryGpu(memGb, dedicated.name);
  if (integrated) return s.summaryIntegrated(memGb, integrated.name);
  return s.summaryCpuOnly(memGb);
}

export function buildDiagnostics(error: unknown, measureBandwidth: boolean): string {
  return JSON.stringify(
    {
      app: "aangan",
      kind: "scan_failed",
      at: new Date().toISOString(),
      measure_bandwidth: measureBandwidth,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
    },
    null,
    2,
  );
}

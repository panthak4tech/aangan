import type { Placement } from "@/api/types";
import { en } from "@/i18n/en";

export function describePlacement(p: Placement): string {
  const t = en.detail.placement;
  switch (p.kind) {
    case "full_gpu":
      return t.full_gpu;
    case "partial_gpu":
      return t.partial_gpu(p.gpu_layers, p.total_layers);
    case "cpu_only":
      return t.cpu_only;
    case "no_fit":
      return t.no_fit;
  }
}

export function describeReason(key: string): string {
  return (en.reasons as Record<string, string>)[key] ?? key;
}

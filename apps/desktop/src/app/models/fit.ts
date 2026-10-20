import type { Estimate, Fit, HardwareProfile, Recommendation } from "@/api/types";

export const FIT_VARIANT: Record<Fit, "fit-great" | "fit-good" | "fit-slow" | "fit-too-slow" | "fit-wont-fit"> = {
  great: "fit-great",
  good: "fit-good",
  slow: "fit-slow",
  too_slow: "fit-too-slow",
  wont_fit: "fit-wont-fit",
};

export const CONTEXT_OPTIONS = [2048, 4096, 8192, 16384, 32768] as const;

/** Memory pool the estimate is compared against: VRAM when on a dedicated GPU, else free RAM. */
export function availableFor(p: HardwareProfile, e: Estimate): { bytes: number; onGpu: boolean } {
  const gpu = p.gpus.find((g) => !g.is_integrated && g.dedicated_vram_bytes > 0);
  if (gpu && (e.placement.kind === "full_gpu" || e.placement.kind === "partial_gpu"))
    return { bytes: gpu.dedicated_vram_bytes, onGpu: true };
  return { bytes: p.memory.available_bytes, onGpu: false };
}

export interface FilteredRecommendations {
  fitting: Recommendation[];
  wontFit: Recommendation[];
  wontFitCount: number;
}

export function filterRecs(
  recs: Recommendation[],
  query: string,
  showWontFit: boolean,
): FilteredRecommendations {
  const q = query.trim().toLowerCase();
  const matches = recs.filter(
    (r) =>
      !q ||
      r.model.name.toLowerCase().includes(q) ||
      r.model.family.toLowerCase().includes(q) ||
      r.model.tags.some((t) => t.toLowerCase().includes(q)),
  );
  const fitting = matches
    .filter((r) => r.estimate.fit !== "wont_fit")
    .sort((a, b) => b.estimate.decode_tps - a.estimate.decode_tps);
  const wontFit = matches
    .filter((r) => r.estimate.fit === "wont_fit")
    .sort((a, b) => a.model.file_size_bytes - b.model.file_size_bytes);

  return {
    fitting,
    wontFit: showWontFit ? wontFit : [],
    wontFitCount: recs.filter((r) => r.estimate.fit === "wont_fit").length,
  };
}

export function nothingFitsComfortably(recs: Recommendation[]): boolean {
  return !recs.some((r) => r.estimate.fit === "great" || r.estimate.fit === "good");
}

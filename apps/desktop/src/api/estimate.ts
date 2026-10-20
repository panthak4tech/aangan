import type { Estimate, Fit, HardwareProfile, ModelSpec, Placement, Recommendation } from "./types";

const GB = 1024 ** 3;
const OVERHEAD = 0.5 * GB;
const VRAM_HEADROOM = 1 * GB;
const EFFICIENCY = 0.6;

export function kvCacheBytes(m: ModelSpec, context: number): number {
  return 2 * m.n_layers * m.n_kv_heads * m.head_dim * context * 2;
}

function fitFor(tps: number, placement: Placement): Fit {
  if (placement.kind === "no_fit") return "wont_fit";
  if (tps >= 20) return "great";
  if (tps >= 10) return "good";
  if (tps >= 4) return "slow";
  return "too_slow";
}

export function estimateModel(p: HardwareProfile, m: ModelSpec, context: number): Estimate {
  const weights = m.file_size_bytes;
  const kv = kvCacheBytes(m, context);
  const total = weights + kv + OVERHEAD;
  const reasons: string[] = [];

  const gpu = p.gpus.find((g) => !g.is_integrated && g.dedicated_vram_bytes > 0);
  const ramBw = p.memory.read_bandwidth_gbps ?? 30;
  const activeBytes = (weights * m.active_params_b) / m.params_b;
  const ramTps = ((ramBw * GB) / activeBytes) * EFFICIENCY;

  let placement: Placement;
  let tps = 0;

  if (gpu) {
    const usable = gpu.dedicated_vram_bytes - VRAM_HEADROOM;
    const gpuBw = gpu.bandwidth_gbps ?? 200;
    const gpuTps = ((gpuBw * GB) / activeBytes) * EFFICIENCY;
    if (total <= usable) {
      placement = { kind: "full_gpu" };
      tps = gpuTps;
      reasons.push("reason_full_gpu");
    } else {
      const frac = Math.max(0, (usable - kv - OVERHEAD) / weights);
      const gpuLayers = Math.floor(frac * m.n_layers);
      if (gpuLayers > 0 && total - usable <= p.memory.available_bytes) {
        placement = { kind: "partial_gpu", gpu_layers: gpuLayers, total_layers: m.n_layers };
        const f = gpuLayers / m.n_layers;
        tps = 1 / (f / gpuTps + (1 - f) / ramTps);
        reasons.push("reason_partial_gpu");
      } else {
        placement = total <= p.memory.available_bytes ? { kind: "cpu_only" } : { kind: "no_fit" };
        tps = placement.kind === "cpu_only" ? ramTps : 0;
      }
    }
  } else if (total <= p.memory.available_bytes) {
    placement = { kind: "cpu_only" };
    tps = ramTps;
    reasons.push("reason_cpu_only");
  } else {
    placement = { kind: "no_fit" };
  }

  if (placement.kind === "no_fit") reasons.push("reason_no_fit");
  if (p.memory.bandwidth_source !== "mock" && p.memory.read_bandwidth_gbps === null)
    reasons.push("reason_bandwidth_assumed");

  return {
    model_id: m.id,
    placement,
    fit: fitFor(tps, placement),
    decode_tps: Math.round(tps * 10) / 10,
    memory_required_bytes: total,
    weights_bytes: weights,
    kv_cache_bytes: kv,
    overhead_bytes: OVERHEAD,
    context,
    confidence: "estimated",
    reasons,
  };
}

export function rankModels(p: HardwareProfile, models: ModelSpec[], context: number): Recommendation[] {
  const rows = models.map((model) => ({ model, estimate: estimateModel(p, model, context) }));
  rows.sort((a, b) => {
    const aWontFit = a.estimate.fit === "wont_fit";
    const bWontFit = b.estimate.fit === "wont_fit";
    if (aWontFit !== bWontFit) return aWontFit ? 1 : -1;
    if (aWontFit) return a.model.file_size_bytes - b.model.file_size_bytes;
    return b.estimate.decode_tps - a.estimate.decode_tps;
  });
  let bestFit: (typeof rows)[number] | undefined;
  for (const row of rows) {
    if (
      (row.estimate.fit === "great" || row.estimate.fit === "good") &&
      (!bestFit || row.model.params_b > bestFit.model.params_b)
    ) {
      bestFit = row;
    }
  }
  const fastest = Math.max(...rows.map((r) => r.estimate.decode_tps));
  return rows.map((r, i) => {
    const badges: string[] = [];
    if (r.model.id === bestFit?.model.id) badges.push("best_fit");
    if (r.estimate.decode_tps === fastest && fastest > 0) badges.push("fastest");
    return { ...r, rank: i + 1, badges };
  });
}

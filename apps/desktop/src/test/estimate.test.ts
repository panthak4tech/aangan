import { describe, expect, it } from "vitest";
import { estimateModel, kvCacheBytes, rankModels } from "@/api/estimate";
import { MODELS, PRESETS } from "@/api/presets";

function getModel(id: string) {
  const model = MODELS.find((item) => item.id.includes(id));
  if (!model) throw new Error(`missing model fixture: ${id}`);
  return model;
}

describe("estimateModel", () => {
  it("computes fp16 KV cache size and reports full-GPU estimates", () => {
    const model = getModel("7b-instruct");
    const estimate = estimateModel(PRESETS.desktop_3060, model, 4096);

    expect(kvCacheBytes(model, 4096)).toBe(
      2 * model.n_layers * model.n_kv_heads * model.head_dim * 4096 * 2,
    );
    expect(estimate.placement).toEqual({ kind: "full_gpu" });
    expect(estimate.fit).toBe("great");
    expect(estimate.decode_tps).toBeGreaterThan(20);
    expect(estimate.reasons).toContain("reason_full_gpu");
    expect(estimate.memory_required_bytes).toBe(
      estimate.weights_bytes + estimate.kv_cache_bytes + estimate.overhead_bytes,
    );
  });

  it("uses available system memory for CPU-only placement", () => {
    const estimate = estimateModel(
      PRESETS.laptop8_cpu,
      getModel("0.5b-instruct"),
      2048,
    );

    expect(estimate.placement).toEqual({ kind: "cpu_only" });
    expect(estimate.fit).toBe("great");
    expect(estimate.reasons).toContain("reason_cpu_only");
    expect(estimate.reasons).not.toContain("reason_bandwidth_assumed");
  });

  it("partially offloads a large-context model when it exceeds VRAM", () => {
    const estimate = estimateModel(
      PRESETS.desktop_3060,
      getModel("14b-instruct"),
      32768,
    );

    expect(estimate.placement.kind).toBe("partial_gpu");
    if (estimate.placement.kind !== "partial_gpu") throw new Error("expected partial GPU placement");
    expect(estimate.placement.gpu_layers).toBeGreaterThan(0);
    expect(estimate.placement.gpu_layers).toBeLessThan(estimate.placement.total_layers);
    expect(estimate.reasons).toContain("reason_partial_gpu");
    expect(estimate.decode_tps).toBeGreaterThan(0);
  });

  it("marks a model as not fitting when neither GPU nor RAM can hold it", () => {
    const estimate = estimateModel(
      PRESETS.laptop8_cpu,
      getModel("14b-instruct"),
      4096,
    );

    expect(estimate.placement).toEqual({ kind: "no_fit" });
    expect(estimate.fit).toBe("wont_fit");
    expect(estimate.decode_tps).toBe(0);
    expect(estimate.reasons).toContain("reason_no_fit");
  });

  it("uses fallback bandwidth estimates when measurements are unavailable", () => {
    const profile = structuredClone(PRESETS.desktop_3060);
    profile.memory.read_bandwidth_gbps = null;
    profile.memory.bandwidth_source = "unavailable";
    profile.gpus[0].bandwidth_gbps = null;
    const estimate = estimateModel(profile, getModel("7b-instruct"), 4096);

    expect(estimate.placement).toEqual({ kind: "full_gpu" });
    expect(estimate.reasons).toContain("reason_bandwidth_assumed");
    expect(estimate.decode_tps).toBeGreaterThan(0);
  });
});

it("ranks usable models before slower ones and marks the fastest result", () => {
  const recommendations = rankModels(PRESETS.desktop_3060, MODELS, 4096);
  const fastest = recommendations.reduce((best, current) =>
    current.estimate.decode_tps > best.estimate.decode_tps ? current : best,
  );

  expect(recommendations.map((item) => item.rank)).toEqual(
    recommendations.map((_, index) => index + 1),
  );
  expect(recommendations[0].estimate.fit).not.toBe("wont_fit");
  expect(fastest.badges).toContain("fastest");
  expect(recommendations.filter((item) => item.badges.includes("best_fit"))).toHaveLength(1);
});

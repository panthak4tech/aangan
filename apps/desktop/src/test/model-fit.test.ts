import { describe, expect, it } from "vitest";
import { rankModels } from "@/api/estimate";
import { MODELS, PRESETS } from "@/api/presets";
import { availableFor, filterRecs, FIT_VARIANT, nothingFitsComfortably } from "@/app/models/fit";

const recommendations = rankModels(PRESETS.desktop_3060, MODELS, 4096);

describe("model recommendation presentation", () => {
  it("maps every fit state to its badge style", () => {
    expect(FIT_VARIANT).toEqual({
      great: "fit-great",
      good: "fit-good",
      slow: "fit-slow",
      too_slow: "fit-too-slow",
      wont_fit: "fit-wont-fit",
    });
  });

  it("uses the estimator's usable memory budgets instead of momentary free memory", () => {
    const recommendation = recommendations[0];
    expect(availableFor(PRESETS.desktop_3060, recommendation.estimate)).toEqual({
      bytes: Math.floor(PRESETS.desktop_3060.gpus[0].dedicated_vram_bytes * 0.9),
      onGpu: true,
    });

    const cpuProfile = structuredClone(PRESETS.laptop16_igpu);
    cpuProfile.gpus.push({ ...PRESETS.desktop_3060.gpus[0], is_integrated: true });
    cpuProfile.memory.available_bytes = 100_000_000;
    const cpuEstimate = { ...recommendation.estimate, placement: { kind: "cpu_only" as const } };
    expect(availableFor(cpuProfile, cpuEstimate)).toEqual({
      bytes: Math.floor(cpuProfile.memory.total_bytes * 0.7),
      onGpu: false,
    });
  });

  it("uses the largest discrete GPU when an integrated adapter appears first", () => {
    const profile = structuredClone(PRESETS.laptop16_igpu);
    profile.gpus[0] = {
      ...profile.gpus[0],
      name: "Intel(R) UHD Graphics",
      dedicated_vram_bytes: 0.1 * 1024 ** 3,
      is_integrated: false,
    };
    profile.gpus.push({
      name: "NVIDIA GeForce RTX 4070 Laptop GPU",
      vendor: "nvidia",
      dedicated_vram_bytes: 8 * 1024 ** 3,
      shared_memory_bytes: 8 * 1024 ** 3,
      is_integrated: false,
      bandwidth_gbps: 256,
      bandwidth_source: "estimated",
    });
    const gpuEstimate = {
      ...recommendations[0].estimate,
      placement: { kind: "partial_gpu" as const, gpu_layers: 24, total_layers: 48 },
    };

    expect(availableFor(profile, gpuEstimate)).toEqual({
      bytes: Math.floor(8 * 1024 ** 3 * 0.9),
      onGpu: true,
    });
  });

  it("filters by model name, family, or tag and preserves recommendation rank", () => {
    const reversed = [...recommendations].reverse();
    expect(filterRecs(reversed, "  CODING ", true).fitting.map((item) => item.model.tags)).toEqual([
      expect.arrayContaining(["coding"]),
    ]);
    expect(filterRecs(reversed, "qwen2.5", true).fitting.map((item) => item.rank)).toEqual(
      recommendations
        .filter((item) => item.estimate.fit !== "wont_fit")
        .map((item) => item.rank),
    );
  });

  it("splits, sorts and counts non-fitting models while hiding them by default", () => {
    const onlySlow = recommendations.map((item) => ({
      ...item,
      estimate: { ...item.estimate, fit: "slow" as const },
    }));
    const mixed = [
      {
        ...onlySlow[0],
        model: { ...onlySlow[0].model, file_size_bytes: 2_000 },
        estimate: { ...onlySlow[0].estimate, fit: "wont_fit" as const },
      },
      {
        ...onlySlow[1],
        model: { ...onlySlow[1].model, file_size_bytes: 1_000 },
        estimate: { ...onlySlow[1].estimate, fit: "wont_fit" as const },
      },
      {
        ...onlySlow[2],
        estimate: { ...onlySlow[2].estimate, fit: "good" as const, decode_tps: 10 },
      },
      {
        ...onlySlow[3],
        estimate: { ...onlySlow[3].estimate, fit: "slow" as const, decode_tps: 20 },
      },
    ];

    const hidden = filterRecs(mixed, "", false);
    expect(hidden.fitting.map((item) => item.estimate.decode_tps)).toEqual([20, 10]);
    expect(hidden.wontFit).toHaveLength(0);
    expect(hidden.wontFitCount).toBe(2);

    const shown = filterRecs(mixed, "", true);
    expect(shown.wontFit.map((item) => item.model.file_size_bytes)).toEqual([1_000, 2_000]);
    expect(shown.wontFitCount).toBe(2);
    expect(nothingFitsComfortably(onlySlow)).toBe(true);
    expect(nothingFitsComfortably(mixed)).toBe(false);
  });
});

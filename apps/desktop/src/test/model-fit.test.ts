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

  it("uses dedicated GPU memory only for GPU placements", () => {
    const recommendation = recommendations[0];
    expect(availableFor(PRESETS.desktop_3060, recommendation.estimate)).toEqual({
      bytes: PRESETS.desktop_3060.gpus[0].dedicated_vram_bytes,
      onGpu: true,
    });

    const cpuProfile = structuredClone(PRESETS.laptop16_igpu);
    cpuProfile.gpus.push({ ...PRESETS.desktop_3060.gpus[0], is_integrated: true });
    const cpuEstimate = { ...recommendation.estimate, placement: { kind: "cpu_only" as const } };
    expect(availableFor(cpuProfile, cpuEstimate)).toEqual({
      bytes: cpuProfile.memory.available_bytes,
      onGpu: false,
    });
  });

  it("filters by model name, family, or tag and preserves recommendation rank", () => {
    const reversed = [...recommendations].reverse();
    expect(filterRecs(reversed, "  CODING ", true).map((item) => item.model.tags)).toEqual([
      expect.arrayContaining(["coding"]),
    ]);
    expect(filterRecs(reversed, "qwen2.5", true).map((item) => item.rank)).toEqual(
      recommendations.map((item) => item.rank),
    );
  });

  it("hides non-fitting models by default and reports when none fit comfortably", () => {
    const onlySlow = recommendations.map((item) => ({
      ...item,
      estimate: { ...item.estimate, fit: "slow" as const },
    }));
    const mixed = [
      { ...onlySlow[0], estimate: { ...onlySlow[0].estimate, fit: "wont_fit" as const } },
      { ...onlySlow[1], estimate: { ...onlySlow[1].estimate, fit: "good" as const } },
    ];

    expect(filterRecs(mixed, "", false)).toHaveLength(1);
    expect(filterRecs(mixed, "", true)).toHaveLength(2);
    expect(nothingFitsComfortably(onlySlow)).toBe(true);
    expect(nothingFitsComfortably(mixed)).toBe(false);
  });
});

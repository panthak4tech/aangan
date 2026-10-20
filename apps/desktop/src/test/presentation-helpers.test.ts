import { describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import { describePlacement, describeReason } from "@/app/models/placement";
import { formatBytes, formatGbps, hasAvx2 } from "@/app/scan/format";
import { buildDiagnostics, summarizeProfile } from "@/app/wizard/summary";
import { PRESETS } from "@/api/presets";

describe("hardware formatting helpers", () => {
  it("formats byte counts across GB and TB ranges", () => {
    expect(formatBytes(1024 ** 3)).toBe("1 GB");
    expect(formatBytes(100 * 1024 ** 3)).toBe("100 GB");
    expect(formatBytes(1000 * 1024 ** 3)).toBe("1.0 TB");
  });

  it("formats bandwidth with concise precision and recognizes AVX2 case-insensitively", () => {
    expect(formatGbps(42.25)).toBe("42.3 GB/s");
    expect(formatGbps(100.4)).toBe("100 GB/s");
    expect(hasAvx2(["sse4.2", "AVX2"])).toBe(true);
    expect(hasAvx2(["avx", "fma"])).toBe(false);
  });

  it("describes each placement and falls back to the reason key", () => {
    expect(describePlacement({ kind: "full_gpu" })).toBe(en.detail.placement.full_gpu);
    expect(describePlacement({ kind: "partial_gpu", gpu_layers: 8, total_layers: 32 })).toBe(
      en.detail.placement.partial_gpu(8, 32),
    );
    expect(describePlacement({ kind: "cpu_only" })).toBe(en.detail.placement.cpu_only);
    expect(describePlacement({ kind: "no_fit" })).toBe(en.detail.placement.no_fit);
    expect(describeReason("reason_full_gpu")).toBe(en.reasons.reason_full_gpu);
    expect(describeReason("untranslated_reason")).toBe("untranslated_reason");
  });
});

describe("first-run summary helpers", () => {
  it("summarizes dedicated GPU, integrated GPU, and CPU-only systems", () => {
    const dedicated = PRESETS.desktop_3060;
    const integrated = PRESETS.laptop16_igpu;
    const cpuOnly = PRESETS.laptop8_cpu;

    expect(summarizeProfile(dedicated)).toContain(dedicated.gpus[0].name);
    expect(summarizeProfile(integrated)).toContain(integrated.gpus[0].name);
    expect(summarizeProfile(cpuOnly)).toContain("memory");
  });

  it("serializes diagnostic errors and non-error values as local JSON", () => {
    const error = JSON.parse(buildDiagnostics(new TypeError("probe failed"), true));
    expect(error).toMatchObject({
      app: "aangan",
      kind: "scan_failed",
      measure_bandwidth: true,
      error: { name: "TypeError", message: "probe failed" },
      user_agent: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(error.at))).toBe(false);

    const value = JSON.parse(buildDiagnostics("unknown failure", false));
    expect(value.error).toBe("unknown failure");
    expect(value.measure_bandwidth).toBe(false);
  });
});

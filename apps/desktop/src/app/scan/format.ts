import { en } from "@/i18n/en";

const GB = 1024 ** 3;
const u = en.views.scan.units;

export function formatBytes(bytes: number): string {
  const gb = bytes / GB;
  if (gb >= 1000) return u.tb((gb / 1024).toFixed(1));
  return u.gb(gb >= 100 ? gb.toFixed(0) : gb.toFixed(1).replace(/\.0$/, ""));
}

export function formatGbps(n: number): string {
  return u.gbps(n >= 100 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, ""));
}

export function hasAvx2(features: string[]): boolean {
  return features.some((f) => f.toLowerCase() === "avx2");
}

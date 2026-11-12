export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

export function formatRate(bytesPerSec: number): string {
  return bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : "—";
}

export function formatEta(secs: number | null | undefined): string {
  if (secs == null || !Number.isFinite(secs)) return "—";
  if (secs < 60) return `${Math.max(1, Math.round(secs))} s`;
  if (secs < 3600) return `${Math.floor(secs / 60)} min ${Math.round(secs % 60)} s`;
  return `${Math.floor(secs / 3600)} h ${Math.round((secs % 3600) / 60)} min`;
}

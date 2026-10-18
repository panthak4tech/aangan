import { cn } from "@/lib/utils";

/** Compact horizontal gauge: label left, value right, thin bar below. */
export function MetricGauge({
  label,
  value,
  fraction,
  compact = false,
}: {
  label: string;
  value: string;
  fraction: number;
  compact?: boolean;
}) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div className={cn("flex flex-col gap-1.5", compact ? "text-xs" : "text-sm")}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-card-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">{value}</span>
      </div>
      <div
        className={cn("w-full overflow-hidden rounded-full bg-muted", compact ? "h-1.5" : "h-2.5")}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label={label}
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

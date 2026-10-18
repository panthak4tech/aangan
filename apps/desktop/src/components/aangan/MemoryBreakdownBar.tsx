import { cn } from "@/lib/utils";

export interface MemorySegment {
  key: string;
  label: string;
  bytes: number;
  tone: "primary" | "secondary" | "muted";
}

const TONE: Record<MemorySegment["tone"], string> = {
  primary: "bg-primary",
  secondary: "bg-chart-3",
  muted: "bg-muted-foreground",
};

/** Stacked bar of memory parts against an available-memory marker. */
export function MemoryBreakdownBar({
  segments,
  availableBytes,
  availableLabel,
  format,
}: {
  segments: MemorySegment[];
  availableBytes: number;
  availableLabel: string;
  format: (bytes: number) => string;
}) {
  const used = segments.reduce((s, x) => s + x.bytes, 0);
  const scale = Math.max(used, availableBytes) || 1;
  const over = used > availableBytes;
  const markerPct = (availableBytes / scale) * 100;

  return (
    <div className="flex flex-col gap-3">
      <div className="relative pt-5">
        <div
          className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-[11px] font-medium text-muted-foreground"
          style={{ left: `${Math.min(Math.max(markerPct, 8), 92)}%` }}
        >
          {availableLabel}
        </div>
        <div className="flex h-4 w-full overflow-hidden rounded-full bg-muted">
          {segments.map((s) => (
            <div
              key={s.key}
              className={cn("h-full", TONE[s.tone])}
              style={{ width: `${(s.bytes / scale) * 100}%` }}
              title={`${s.label}: ${format(s.bytes)}`}
            />
          ))}
        </div>
        <div
          className={cn("absolute bottom-[-4px] top-4 w-0.5 rounded", over ? "bg-destructive" : "bg-foreground")}
          style={{ left: `calc(${markerPct}% - 1px)` }}
          aria-hidden
        />
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className={cn("h-2.5 w-2.5 rounded-sm", TONE[s.tone])} />
            <span className="text-muted-foreground">{s.label}</span>
            <span className="tabular-nums text-foreground">{format(s.bytes)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

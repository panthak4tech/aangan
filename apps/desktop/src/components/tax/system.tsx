import * as React from "react";
import { Cpu, Gauge, HardDrive, MemoryStick, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge, Card, Table, Tooltip } from "@/components/ui/display";

/* ---------- MetricGauge ---------- */
export interface MetricGaugeProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  /** Current value, in `unit`. */
  value: number;
  /** Upper bound of the scale. Default 100 (percent). */
  max?: number;
  /** Unit shown after the value, e.g. "%", "°C", "GB", "tok/s". */
  unit?: string;
  detail?: string;
  /** `radial` ring or compact horizontal `bar`. */
  variant?: "radial" | "bar";
  size?: "sm" | "md";
}
/** Usage gauge; tone shifts to warning at ≥70% of max and destructive at ≥90%. */
export const MetricGauge = React.forwardRef<HTMLDivElement, MetricGaugeProps>(
  ({ label, value, max = 100, unit = "%", detail, variant = "radial", size = "md", className, ...props }, ref) => {
    const safeMax = max > 0 ? max : 100;
    const v = Math.max(0, Math.min(safeMax, value));
    const pct = (v / safeMax) * 100;
    const display = Number.isInteger(v) || v >= 100 ? Math.round(v) : v.toFixed(1);
    const meter = { role: "meter" as const, "aria-label": label, "aria-valuenow": v, "aria-valuemin": 0, "aria-valuemax": safeMax, "aria-valuetext": `${display} ${unit}` };

    if (variant === "bar") {
      const fill = pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-warning" : "bg-primary";
      return (
        <div ref={ref} {...meter} className={cn("flex w-full flex-col gap-1.5", className)} {...props}>
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="font-medium">{label}</span>
            <span className="font-mono font-semibold">{display}<span className="ml-0.5 text-xs text-muted-foreground">{unit}</span></span>
          </div>
          <div className={cn("w-full overflow-hidden rounded-full bg-muted", size === "sm" ? "h-1.5" : "h-2")}>
            <div className={cn("h-full rounded-full transition-all", fill)} style={{ width: `${pct}%` }} />
          </div>
          {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
        </div>
      );
    }

    const r = 42, c = 2 * Math.PI * r;
    const tone = pct >= 90 ? "stroke-destructive" : pct >= 70 ? "stroke-warning" : "stroke-primary";
    return (
      <div ref={ref} {...meter} className={cn("flex flex-col items-center gap-2", className)} {...props}>
        <div className={cn("relative", size === "sm" ? "size-20" : "size-28")}>
          <svg viewBox="0 0 100 100" className="size-full -rotate-90">
            <circle cx="50" cy="50" r={r} fill="none" strokeWidth="8" className="stroke-muted" />
            <circle cx="50" cy="50" r={r} fill="none" strokeWidth="8" strokeLinecap="round" className={cn(tone, "transition-all")} strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
          </svg>
          <span className={cn("absolute inset-0 flex items-center justify-center font-mono font-semibold", size === "sm" ? "text-base" : "text-xl")}>
            {display}<span className="text-xs text-muted-foreground">{unit}</span>
          </span>
        </div>
        <div className="text-center">
          <p className="text-sm font-medium">{label}</p>
          {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
        </div>
      </div>
    );
  },
);
MetricGauge.displayName = "MetricGauge";

/* ---------- SystemSpecCard ---------- */
const specIcons = { cpu: Cpu, gpu: Zap, ram: MemoryStick, disk: HardDrive, npu: Gauge };
export interface SystemSpec { kind: keyof typeof specIcons; label: string; value: string; sub?: string }
export interface SystemSpecCardProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string;
  specs: SystemSpec[];
}
/** Read-only hardware summary of the host machine. */
export const SystemSpecCard = React.forwardRef<HTMLDivElement, SystemSpecCardProps>(({ title = "This computer", specs, className, ...props }, ref) => (
  <Card ref={ref} className={cn("flex flex-col gap-4", className)} {...props}>
    <h3 className="font-display text-lg font-semibold">{title}</h3>
    <dl className="grid gap-3 sm:grid-cols-2">
      {specs.map((s) => {
        const Icon = specIcons[s.kind];
        return (
          <div key={s.label} className="flex items-start gap-3 rounded-lg bg-muted p-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-card text-primary"><Icon className="size-4" aria-hidden /></span>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{s.label}</dt>
              <dd className="truncate text-sm font-medium">{s.value}</dd>
              {s.sub && <dd className="text-xs text-muted-foreground">{s.sub}</dd>}
            </div>
          </div>
        );
      })}
    </dl>
  </Card>
));
SystemSpecCard.displayName = "SystemSpecCard";

/* ---------- Shared: value source ---------- */
export type ValueSource = "estimated" | "measured";
/** Prefix "~" for estimated values. */
export function formatSourced(value: React.ReactNode, source: ValueSource) {
  return source === "estimated" ? <>~{value}</> : value;
}
export interface SourceBadgeProps extends React.HTMLAttributes<HTMLSpanElement> { source: ValueSource }
/** "Estimated" / "Measured" label for performance numbers. */
export const SourceBadge = React.forwardRef<HTMLSpanElement, SourceBadgeProps>(({ source, ...props }, ref) => (
  <Badge ref={ref} variant={source === "measured" ? "success" : "outline"} {...props}>{source === "measured" ? "Measured" : "Estimated"}</Badge>
));
SourceBadge.displayName = "SourceBadge";

/* ---------- ModelCard ---------- */
export type ModelFit = "great" | "good" | "slow" | "too_slow" | "unsupported";
export const modelFitMeta: Record<ModelFit, { label: string; variant: "success" | "info" | "warning" | "destructive" }> = {
  great: { label: "Runs great", variant: "success" },
  good: { label: "Runs well", variant: "info" },
  slow: { label: "May be slow", variant: "warning" },
  too_slow: { label: "Too slow", variant: "warning" },
  unsupported: { label: "Won't fit", variant: "destructive" },
};
export type LicenseKind = "open-source" | "open-weight";
const licenseMeta: Record<LicenseKind, { label: string; tip: string }> = {
  "open-source": { label: "Open source", tip: "Open source: weights and license allow free use, changes and sharing under a standard OSI-style license." },
  "open-weight": { label: "Open weight", tip: "Open weight: free to download, but use is governed by the publisher's custom terms. Check them before commercial use." },
};
export interface ModelCardProps extends React.HTMLAttributes<HTMLDivElement> {
  name: string;
  params: string;
  quant: string;
  sizeGb: number;
  tokensPerSec: number;
  fit: ModelFit;
  /** License name, e.g. "Apache-2.0", "Llama 3.1". */
  license: string;
  licenseKind: LicenseKind;
  /** Whether speed comes from an estimate or a run on this machine. */
  source: ValueSource;
  selected?: boolean;
  action?: React.ReactNode;
}
/** A suggested local model with fit score, expected speed and license kind. */
export const ModelCard = React.forwardRef<HTMLDivElement, ModelCardProps>(
  ({ name, params, quant, sizeGb, tokensPerSec, fit, license, licenseKind, source, selected, action, className, ...props }, ref) => {
    const f = modelFitMeta[fit];
    const lk = licenseMeta[licenseKind];
    return (
      <Card ref={ref} padding="sm" className={cn("flex flex-col gap-3 transition-shadow", selected && "ring-2 ring-primary", (fit === "unsupported" || fit === "too_slow") && "opacity-75", className)} {...props}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-display font-semibold">{name}</p>
            <p className="text-xs text-muted-foreground">{params} · {quant} · {license}</p>
          </div>
          <Badge variant={f.variant}>{f.label}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tooltip content={lk.tip}>
            <Badge variant="neutral" tabIndex={0} aria-label={`${lk.label}. ${lk.tip}`} className="cursor-help focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{lk.label}</Badge>
          </Tooltip>
          <SourceBadge source={source} />
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-md bg-muted px-3 py-2"><p className="text-xs text-muted-foreground">Speed</p><p className="font-mono font-medium">{formatSourced(tokensPerSec, source)} tok/s</p></div>
          <div className="rounded-md bg-muted px-3 py-2"><p className="text-xs text-muted-foreground">Download</p><p className="font-mono font-medium">{sizeGb.toFixed(1)} GB</p></div>
        </div>
        {action}
      </Card>
    );
  },
);
ModelCard.displayName = "ModelCard";

/* ---------- BenchmarkTable ---------- */
export interface BenchmarkRow { model: string; quant: string; tokensPerSec: number; firstTokenMs: number; ramGb: number }
export interface BenchmarkTableProps extends React.HTMLAttributes<HTMLDivElement> {
  rows: BenchmarkRow[];
  /** Whether the numbers are estimates or measured on this machine. */
  source: ValueSource;
  caption?: string;
}
/** Speed per model; fastest row highlighted. */
export const BenchmarkTable = React.forwardRef<HTMLDivElement, BenchmarkTableProps>(({ rows, source, caption, className, ...props }, ref) => {
  const best = Math.max(...rows.map((r) => r.tokensPerSec));
  const s = (v: React.ReactNode) => formatSourced(v, source);
  return (
    <div ref={ref} className={cn("flex flex-col gap-2", className)} {...props}>
      <div><SourceBadge source={source} /></div>
      <Table>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead><tr><th>Model</th><th>Quant</th><th className="text-right">Tokens/s</th><th className="text-right">First token</th><th className="text-right">RAM</th></tr></thead>
        <tbody className="font-mono">
          {rows.map((r) => (
            <tr key={r.model + r.quant}>
              <td className="font-sans font-medium">{r.model} {r.tokensPerSec === best && <Badge variant="success" className="ml-1">Fastest</Badge>}</td>
              <td>{r.quant}</td>
              <td className="text-right">{s(r.tokensPerSec)}</td>
              <td className="text-right">{s(r.firstTokenMs)} ms</td>
              <td className="text-right">{s(r.ramGb)} GB</td>
            </tr>
          ))}
        </tbody>
      </Table>
      {caption && <p className="text-xs text-muted-foreground">{caption}</p>}
    </div>
  );
});
BenchmarkTable.displayName = "BenchmarkTable";

/* ---------- MemoryBreakdownBar ---------- */
export interface MemoryBreakdownBarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Model weights, GB. */
  weightsGb: number;
  /** KV cache / context memory, GB. */
  contextGb: number;
  /** Runtime overhead, GB. */
  overheadGb: number;
  /** Memory available on this machine, GB — drawn as a marker. */
  availableGb: number;
  label?: string;
}
/** Stacked bar of the memory a model needs, with a marker for available memory. */
export const MemoryBreakdownBar = React.forwardRef<HTMLDivElement, MemoryBreakdownBarProps>(
  ({ weightsGb, contextGb, overheadGb, availableGb, label = "Memory needed", className, ...props }, ref) => {
    const total = weightsGb + contextGb + overheadGb;
    const scale = Math.max(total, availableGb) * 1.08 || 1;
    const fits = total <= availableGb;
    const parts = [
      { name: "Weights", gb: weightsGb, cls: "bg-chart-1" },
      { name: "Context memory", gb: contextGb, cls: "bg-chart-2" },
      { name: "Overhead", gb: overheadGb, cls: "bg-chart-3" },
    ];
    const pctOf = (gb: number) => `${(gb / scale) * 100}%`;
    return (
      <div ref={ref} className={cn("flex flex-col gap-3", className)} {...props}>
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="font-medium">{label}</span>
          <span className="font-mono">{total.toFixed(1)} / {availableGb.toFixed(1)} GB
            <Badge variant={fits ? "success" : "destructive"} className="ml-2 font-sans">{fits ? "Fits" : "Won't fit"}</Badge>
          </span>
        </div>
        <div className="relative pt-5">
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`${parts.map((p) => `${p.name} ${p.gb.toFixed(1)} GB`).join(", ")}. Available ${availableGb.toFixed(1)} GB.`}>
            {parts.map((p) => <div key={p.name} className={p.cls} style={{ width: pctOf(p.gb) }} />)}
          </div>
          <div className="absolute bottom-0 top-0 flex -translate-x-1/2 flex-col items-center" style={{ left: pctOf(availableGb) }} aria-hidden>
            <span className="whitespace-nowrap text-[0.6875rem] font-medium text-muted-foreground">Available</span>
            <span className="w-0.5 flex-1 rounded-full bg-foreground" />
          </div>
        </div>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {parts.map((p) => (
            <li key={p.name} className="flex items-center gap-1.5"><span className={cn("size-2.5 rounded-sm", p.cls)} aria-hidden />{p.name} <span className="font-mono text-foreground">{p.gb.toFixed(1)} GB</span></li>
          ))}
        </ul>
      </div>
    );
  },
);
MemoryBreakdownBar.displayName = "MemoryBreakdownBar";

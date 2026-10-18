import { Sparkles, Zap } from "lucide-react";
import type { HardwareProfile, Recommendation } from "@/api/types";
import { Badge } from "@/components/primitives/badge";
import { Card } from "@/components/primitives/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/primitives/tooltip";
import { en } from "@/i18n/en";
import { cn } from "@/lib/utils";
import { EstimateBadge } from "../EstimateBadge";
import { formatBytes } from "../scan/format";
import { availableFor, FIT_VARIANT } from "./fit";

export function ModelCard({
  rec,
  profile,
  onOpen,
}: {
  rec: Recommendation;
  profile: HardwareProfile;
  onOpen: () => void;
}) {
  const t = en.views.models;
  const { model, estimate } = rec;
  const wontFit = estimate.fit === "wont_fit";
  const avail = availableFor(profile, estimate);
  const licenseKind = model.license.osi_open ? "open_source" : "open_weight";
  const memRatio = Math.min(1, estimate.memory_required_bytes / avail.bytes);

  return (
    <Card
      role="button"
      tabIndex={0}
      aria-label={t.openDetails(model.name)}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "flex cursor-pointer flex-col gap-4 p-5 shadow-none transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        rec.badges.includes("best_fit") && "border-primary",
        wontFit && "opacity-70",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={FIT_VARIANT[estimate.fit]}>{en.fit[estimate.fit]}</Badge>
        {rec.badges.includes("best_fit") && (
          <Badge>
            <Sparkles className="mr-1 h-3 w-3" />
            {en.badges.best_fit}
          </Badge>
        )}
        {rec.badges.includes("fastest") && (
          <Badge variant="secondary">
            <Zap className="mr-1 h-3 w-3" />
            {en.badges.fastest}
          </Badge>
        )}
      </div>

      <div className="flex flex-col gap-0.5">
        <h3 className="font-display text-lg font-semibold leading-tight text-card-foreground">{model.name}</h3>
        <p className="text-xs text-muted-foreground">
          {t.params(model.params_b)} · {model.quant}
        </p>
      </div>

      <div onClick={(e) => e.stopPropagation()} className="w-fit">
        {wontFit ? (
          <span className="text-sm text-muted-foreground">{en.fit.wont_fit}</span>
        ) : (
          <EstimateBadge tps={estimate.decode_tps} />
        )}
      </div>

      <div className="flex flex-col gap-1.5 text-xs">
        <div className="flex justify-between gap-2">
          <span className="shrink-0 text-muted-foreground">{avail.onGpu ? t.onGpu : t.onRam}</span>
          <span className="text-right tabular-nums text-card-foreground">
            {t.memoryNeeded(formatBytes(estimate.memory_required_bytes), formatBytes(avail.bytes))}
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full", wontFit ? "bg-destructive" : "bg-primary")}
            style={{ width: `${memRatio * 100}%` }}
          />
        </div>
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-border pt-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <span onClick={(e) => e.stopPropagation()}>
              <Badge variant="outline">{t.license[licenseKind]}</Badge>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">{t.license[`${licenseKind}_tip`]}</TooltipContent>
        </Tooltip>
        <span className="text-xs text-muted-foreground">{model.license.id}</span>
      </div>
    </Card>
  );
}

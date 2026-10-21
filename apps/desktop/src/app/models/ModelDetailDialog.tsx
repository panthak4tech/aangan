import { AlertTriangle, Download } from "lucide-react";
import type { HardwareProfile, Recommendation } from "@/api/types";
import { MemoryBreakdownBar } from "@/components/aangan/MemoryBreakdownBar";
import { Badge } from "@/components/primitives/badge";
import { Button } from "@/components/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/primitives/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/primitives/tooltip";
import { en } from "@/i18n/en";
import { EstimateBadge } from "../EstimateBadge";
import { formatBytes } from "../scan/format";
import { FitBadge } from "./FitBadge";
import { availableFor } from "./fit";
import { describePlacement, describeReason } from "./placement";

export function ModelDetailDialog({
  rec,
  profile,
  onClose,
}: {
  rec: Recommendation | null;
  profile: HardwareProfile | null;
  onClose: () => void;
}) {
  const t = en.detail;
  const lt = en.views.models.license;
  return (
    <Dialog open={!!rec && !!profile} onOpenChange={(o) => !o && onClose()}>
      {rec && profile && (
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          {(() => {
            const { model, estimate } = rec;
            const avail = availableFor(profile, estimate);
            const licenseKind = model.license.osi_open ? "open_source" : "open_weight";
            const facts: [string, string][] = [
              [t.family, model.family],
              [t.params, t.paramsValue(model.params_b)],
              [t.quant, model.quant],
            ];
            return (
              <>
                <DialogHeader className="gap-2">
                  <div className="flex flex-wrap gap-1.5">
                    <FitBadge fit={estimate.fit} />
                    {rec.badges.includes("best_fit") && <Badge variant="accent">{en.badges.best_fit}</Badge>}
                    {rec.badges.includes("fastest") && <Badge variant="secondary">{en.badges.fastest}</Badge>}
                    {model.tags.includes("gated") && <Badge variant="outline">{en.views.models.gated}</Badge>}
                  </div>
                  <DialogTitle className="font-display text-2xl">{model.name}</DialogTitle>
                  <DialogDescription>{t.subtitle(model.family, model.params_b, model.quant)}</DialogDescription>
                </DialogHeader>

                {!model.verified && (
                  <div className="flex items-center gap-2 rounded-lg border border-fit-slow/50 bg-fit-slow/10 px-3 py-2 text-sm text-foreground">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-fit-slow" />
                    {t.unverified}
                  </div>
                )}

                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl bg-muted p-4 text-sm sm:grid-cols-4">
                  {facts.map(([k, v]) => (
                    <div key={k} className="flex flex-col gap-0.5">
                      <dt className="text-xs text-muted-foreground">{k}</dt>
                      <dd className="font-medium text-foreground">{v}</dd>
                    </div>
                  ))}
                  <div className="flex flex-col gap-0.5">
                    <dt className="text-xs text-muted-foreground">{t.license}</dt>
                    <dd className="flex flex-col gap-1 font-medium text-foreground">
                      <span>{model.license.id}</span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="w-fit">
                            <Badge variant="outline">{lt[licenseKind]}</Badge>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">{lt[`${licenseKind}_tip`]}</TooltipContent>
                      </Tooltip>
                    </dd>
                  </div>
                  <div className="col-span-full flex flex-col gap-0.5">
                    <dt className="text-xs text-muted-foreground">{t.licenseLink}</dt>
                    {/* Text only: the app is offline, so links are never opened. */}
                    <dd className="select-all break-all font-mono text-xs text-foreground">{model.license.url}</dd>
                  </div>
                </dl>

                <section className="flex flex-col gap-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-sm font-semibold text-foreground">{t.memoryTitle}</h3>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {t.total(formatBytes(estimate.memory_required_bytes), formatBytes(avail.bytes))}
                    </span>
                  </div>
                  <MemoryBreakdownBar
                    format={formatBytes}
                    availableBytes={avail.bytes}
                    availableLabel={`${t.available} · ${avail.onGpu ? en.views.models.onGpu : en.views.models.onRam}`}
                    segments={[
                      { key: "w", label: t.weights, bytes: estimate.weights_bytes, tone: "primary" },
                      { key: "kv", label: t.context, bytes: estimate.kv_cache_bytes, tone: "secondary" },
                      { key: "o", label: t.overhead, bytes: estimate.overhead_bytes, tone: "muted" },
                    ]}
                  />
                </section>

                <section className="grid gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <h3 className="text-sm font-semibold text-foreground">{t.howTitle}</h3>
                    <p className="text-sm text-muted-foreground">{describePlacement(estimate.placement)}</p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <h3 className="text-sm font-semibold text-foreground">{t.speedTitle}</h3>
                    {estimate.fit === "wont_fit" ? (
                      <p className="text-sm text-muted-foreground">{en.fit.wont_fit}</p>
                    ) : (
                      <EstimateBadge tps={estimate.decode_tps} />
                    )}
                  </div>
                </section>

                {estimate.reasons.length > 0 && (
                  <section className="flex flex-col gap-1.5">
                    <h3 className="text-sm font-semibold text-foreground">{t.reasonsTitle}</h3>
                    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
                      {estimate.reasons.map((r) => (
                        <li key={r}>{describeReason(r)}</li>
                      ))}
                    </ul>
                  </section>
                )}

                <DialogFooter className="gap-2">
                  <Button variant="outline" onClick={onClose}>
                    {t.close}
                  </Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span tabIndex={0} className="inline-flex">
                        <Button disabled aria-disabled>
                          <Download />
                          {t.download}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{t.downloadSoon}</TooltipContent>
                  </Tooltip>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      )}
    </Dialog>
  );
}

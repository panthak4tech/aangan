import { Copy, Cpu, Download, HardDrive, Info, MemoryStick, MonitorCog, RefreshCw } from "lucide-react";
import { useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { copyHardwareReport, saveHardwareReport } from "@/api/api";
import type { HardwareProfile } from "@/api/types";
import { MetricGauge } from "@/components/aangan/MetricGauge";
import { SpecRow, SystemSpecCard } from "@/components/aangan/SystemSpecCard";
import { Alert, AlertDescription, AlertTitle } from "@/components/primitives/alert";
import { Badge } from "@/components/primitives/badge";
import { Button } from "@/components/primitives/button";
import { Skeleton } from "@/components/primitives/skeleton";
import { useToast } from "@/components/ui/toast-provider";
import { en } from "@/i18n/en";
import { formatBytes, formatGbps, hasAvx2 } from "../scan/format";
import { EmptyView } from "./EmptyView";

interface Props {
  profile: HardwareProfile | null;
  scanning: boolean;
  scanError: boolean;
  onRescan: () => void;
}

export function ScanView({ profile, scanning, scanError, onRescan }: Props) {
  const t = en.views.scan;
  const [copying, setCopying] = useState(false);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  if (!profile) return <EmptyView title={t.title} body={t.empty} icon={Cpu} />;

  const json = JSON.stringify(profile, null, 2);
  const copy = async () => {
    setCopying(true);
    try {
      await copyHardwareReport(json);
      toast(t.reportCopied, { variant: "success" });
    } catch (error) {
      toast(t.copyReportFailed(errorMessage(error)), { variant: "destructive" });
    } finally {
      setCopying(false);
    }
  };
  const save = async () => {
    setSaving(true);
    try {
      const path = await saveHardwareReport(json);
      if (path === null) return;
      toast(t.reportSaved(path), {
        variant: "success",
        action: {
          label: t.showInFolder,
          onClick: () => {
            void revealItemInDir(path)
              .catch((error: unknown) => {
                toast(t.revealFailed(errorMessage(error)), { variant: "destructive" });
              });
          },
        },
      });
    } catch (error) {
      toast(t.saveFailed(errorMessage(error)), { variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const { cpu, memory, gpus, disks } = profile;
  const hasIntegrated = gpus.some((g) => g.is_integrated);

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-3xl font-semibold tracking-tight">{t.title}</h1>
          <p className="text-sm text-muted-foreground">{t.subtitle}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onRescan} disabled={scanning}>
            <RefreshCw className={scanning ? "animate-spin" : undefined} />
            {scanning ? t.scanning : t.scanAgain}
          </Button>
          <Button variant="outline" onClick={copy} disabled={copying}>
            <Copy />
            {t.copyJson}
          </Button>
          <Button variant="outline" onClick={save} disabled={saving}>
            <Download />
            {t.saveFile}
          </Button>
        </div>
      </div>

      {scanError && (
        <Alert variant="destructive">
          <Info className="h-4 w-4" />
          <AlertDescription>{t.scanFailed}</AlertDescription>
        </Alert>
      )}

      {hasIntegrated && (
        <Alert variant="info">
          <Info className="h-4 w-4" />
          <AlertTitle>{t.integratedAlertTitle}</AlertTitle>
          <AlertDescription>{t.integratedAlert}</AlertDescription>
        </Alert>
      )}

      {scanning ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-busy="true" aria-label={t.scanning}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SystemSpecCard
          icon={Cpu}
          title={t.cpu.title}
          subtitle={cpu.brand}
          badges={hasAvx2(cpu.features) ? <Badge variant="secondary">{t.cpu.avx2}</Badge> : null}
        >
          <SpecRow label={t.cpu.coresLabel} value={t.cpu.cores(cpu.physical_cores, cpu.logical_cores)} />
        </SystemSpecCard>

        <SystemSpecCard icon={MemoryStick} title={t.memory.title} subtitle={formatBytes(memory.total_bytes)}>
          <SpecRow label={t.memory.available} value={formatBytes(memory.available_bytes)} />
          <SpecRow
            label={t.memory.readSpeed}
            value={memory.read_bandwidth_gbps !== null ? formatGbps(memory.read_bandwidth_gbps) : null}
            badge={
              memory.read_bandwidth_gbps !== null ? (
                <Badge variant="measured">{t.memory.measured}</Badge>
              ) : (
                <Badge variant="unknown">{t.memory.notMeasured}</Badge>
              )
            }
          />
        </SystemSpecCard>

        {gpus.length === 0 ? (
          <SystemSpecCard icon={MonitorCog} title={t.gpu.title} subtitle={t.gpu.none} />
        ) : (
          gpus.map((g) => (
            <SystemSpecCard
              key={g.name}
              icon={MonitorCog}
              title={t.gpu.title}
              subtitle={g.name}
              badges={g.is_integrated ? <Badge variant="outline">{t.gpu.sharesMemory}</Badge> : null}
            >
              <SpecRow
                label={g.is_integrated ? t.gpu.sharedVram : t.gpu.vram}
                value={formatBytes(g.is_integrated ? g.shared_memory_bytes : g.dedicated_vram_bytes)}
              />
              <SpecRow
                label={t.gpu.bandwidth}
                value={g.bandwidth_gbps !== null ? t.units.approx(formatGbps(g.bandwidth_gbps)) : null}
                badge={
                  g.bandwidth_gbps !== null ? (
                    <Badge variant="estimate">{t.gpu.estimated}</Badge>
                  ) : (
                    <Badge variant="unknown">{t.gpu.unknown}</Badge>
                  )
                }
              />
            </SystemSpecCard>
          ))
        )}

        <SystemSpecCard icon={HardDrive} title={t.storage.title}>
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            {disks.map((d) => (
              <MetricGauge
                key={d.mount}
                compact
                label={d.mount}
                value={t.storage.free(formatBytes(d.available_bytes), formatBytes(d.total_bytes))}
                fraction={1 - d.available_bytes / d.total_bytes}
              />
            ))}
          </div>
        </SystemSpecCard>
      </div>
      )}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

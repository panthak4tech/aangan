import { useEffect, useState } from "react";
import {
  checkRuntimeUpdates,
  getNetworkState,
  installRuntime,
  listRuntimes,
  listenNetworkState,
  listenRuntimeProgress,
  removeRuntime,
  setDefaultRuntime,
} from "@/api/api";
import type {
  DownloadProgress,
  InstalledRuntime,
  NetworkState,
  RuntimeCatalog,
  RuntimeCard,
  RuntimeVariant,
} from "@/api/types";
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
import { Skeleton } from "@/components/primitives/skeleton";
import { formatTransferSize } from "@/downloads/format";
import { en } from "@/i18n/en";

type RemoveTarget = {
  runtimeId: string;
  version: string;
  variant: string;
};

export function RuntimesView() {
  const t = en.views.runtimes;
  const [catalog, setCatalog] = useState<RuntimeCatalog | null>(null);
  const [network, setNetwork] = useState<NetworkState | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [error, setError] = useState<string | null>(null);
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>({});
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const [removing, setRemoving] = useState(false);

  const refresh = async () => {
    setError(null);
    try {
      setCatalog(await listRuntimes());
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    let stopListening: (() => void) | undefined;
    let stopNetworkListening: (() => void) | undefined;
    void listRuntimes()
      .then((value) => mounted && setCatalog(value))
      .catch((reason: unknown) => mounted && setError(errorMessage(reason)))
      .finally(() => mounted && setLoading(false));
    void getNetworkState()
      .then((value) => mounted && setNetwork(value))
      .catch((reason: unknown) => mounted && setError(errorMessage(reason)));
    void listenNetworkState((value) => mounted && setNetwork(value))
      .then((unlisten) => {
        if (mounted) stopNetworkListening = unlisten;
        else unlisten();
      })
      .catch((reason: unknown) => mounted && setError(errorMessage(reason)));
    void listenRuntimeProgress((next) => {
      if (mounted) {
        const key = next.id.replace(/-\d+$/, "");
        setProgress((current) => ({ ...current, [key]: next }));
      }
    })
      .then((unlisten) => {
        if (mounted) stopListening = unlisten;
        else unlisten();
      })
      .catch((reason: unknown) => mounted && setError(errorMessage(reason)));
    return () => {
      mounted = false;
      stopListening?.();
      stopNetworkListening?.();
    };
  }, []);

  const updateCatalog = async () => {
    setChecking(true);
    setError(null);
    try {
      setCatalog(await checkRuntimeUpdates());
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setChecking(false);
    }
  };

  const install = async (runtime: RuntimeCard, variant: string) => {
    const id = progressId(runtime.id, variant);
    setInstalling(id);
    setError(null);
    try {
      await installRuntime(runtime.id, variant);
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setInstalling(null);
    }
  };

  const makeDefault = async (runtime: InstalledRuntime) => {
    setError(null);
    try {
      await setDefaultRuntime(runtime.runtimeId, runtime.version, runtime.variant);
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    setRemoving(true);
    setError(null);
    try {
      await removeRuntime(
        removeTarget.runtimeId,
        removeTarget.version,
        removeTarget.variant,
      );
      setRemoveTarget(null);
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setRemoving(false);
    }
  };

  const offline = network?.offlineMode ?? false;

  return (
    <section className="flex max-w-4xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-3xl font-semibold tracking-tight">{t.title}</h1>
          <p className="text-sm text-muted-foreground">{t.subtitle}</p>
        </div>
        <Button
          variant="outline"
          onClick={() => void updateCatalog()}
          disabled={checking || offline}
          title={offline ? t.offline : undefined}
        >
          {checking ? t.checking : t.checkUpdates}
        </Button>
      </header>
      {offline && <p className="text-sm text-muted-foreground">{t.offline}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {catalog?.warning && (
        <p role="alert" className="text-sm text-destructive">{catalog.warning}</p>
      )}
      {loading ? (
        <Skeleton role="status" aria-label={t.loading} className="h-48 w-full" />
      ) : catalog?.runtimes.length ? (
        <div className="flex flex-col gap-4">
          {catalog.runtimes.map((runtime) => {
            const recommended = runtime.variants.find(
              (variant) => variant.variant === runtime.recommendedVariant,
            );
            const chosen = selectedVariants[runtime.id] ?? runtime.recommendedVariant ?? runtime.variants[0]?.variant;
            const currentProgress = chosen
              ? progress[progressId(runtime.id, chosen)]
              : undefined;
            const installId = chosen ? progressId(runtime.id, chosen) : null;
            const isInstalling = installId !== null && installing === installId;
            return (
              <RuntimeCardView
                key={runtime.id}
                runtime={runtime}
                recommended={recommended}
                chosen={chosen}
                progress={currentProgress}
                isInstalling={isInstalling}
                offline={offline}
                labels={t}
                onChoose={(variant) =>
                  setSelectedVariants((current) => ({ ...current, [runtime.id]: variant }))
                }
                onInstall={() => chosen && void install(runtime, chosen)}
                onMakeDefault={(item) => void makeDefault(item)}
                onRemove={(item) => setRemoveTarget(item)}
              />
            );
          })}
        </div>
      ) : (
        <p className="rounded-xl border border-border p-5 text-sm text-muted-foreground">
          {t.empty}
        </p>
      )}
      <div className="rounded-xl border border-dashed border-border p-5">
        <h2 className="font-medium text-foreground">{t.moreEngines}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t.moreEnginesDescription}</p>
        <p className="mt-2 text-xs text-muted-foreground">{t.futureEngines}</p>
      </div>
      <p className="text-xs text-muted-foreground">{t.signatureNote}</p>
      <Dialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !removing) setRemoveTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.removeTitle}</DialogTitle>
            <DialogDescription>
              {removeTarget
                ? t.removeDescription(removeTarget.version, removeTarget.variant)
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRemoveTarget(null)}
              disabled={removing}
            >
              {t.cancel}
            </Button>
            <Button variant="destructive" onClick={() => void confirmRemove()} disabled={removing}>
              {t.remove}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function RuntimeCardView({
  runtime,
  recommended,
  chosen,
  progress,
  isInstalling,
  offline,
  labels,
  onChoose,
  onInstall,
  onMakeDefault,
  onRemove,
}: {
  runtime: RuntimeCard;
  recommended: RuntimeVariant | undefined;
  chosen: string | undefined;
  progress: DownloadProgress | undefined;
  isInstalling: boolean;
  offline: boolean;
  labels: typeof en.views.runtimes;
  onChoose: (variant: string) => void;
  onInstall: () => void;
  onMakeDefault: (runtime: InstalledRuntime) => void;
  onRemove: (runtime: RemoveTarget) => void;
}) {
  const selected = runtime.variants.find((variant) => variant.variant === chosen);
  const progressPercent = progress && progress.total > 0
    ? Math.min(100, Math.floor((progress.done / progress.total) * 100))
    : 0;
  return (
    <article className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-xl font-semibold text-card-foreground">
            {runtime.displayName}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{labels.description}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            {labels.license(runtime.license)} · {labels.version(runtime.version)}
          </p>
        </div>
        <Button
          onClick={onInstall}
          disabled={!selected || isInstalling || offline}
          title={offline ? labels.offline : undefined}
        >
          {isInstalling ? labels.installing : labels.install}
        </Button>
      </div>

      {recommended ? (
        <div className="rounded-xl bg-muted p-3">
          <p className="text-sm font-medium text-foreground">
            {labels.recommended(formatVariant(recommended), formatTransferSize(recommended.sizeBytes))}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{runtime.recommendationReason}</p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{labels.noCompatibleVariant}</p>
      )}

      {selected && selected.variant !== runtime.recommendedVariant && (
        <p className="text-xs text-muted-foreground">
          {labels.selectedVariant(formatVariant(selected), formatTransferSize(selected.sizeBytes))}
        </p>
      )}

      {progress && (
        <div className="flex flex-col gap-2" aria-live="polite">
          <div className="flex justify-between gap-2 text-xs text-muted-foreground">
            <span>{progressLabel(progress, labels)}</span>
            <span>{progressPercent}%</span>
          </div>
          <div
            role="progressbar"
            aria-label={labels.progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPercent}
            className="h-2 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progressPercent}%` }} />
          </div>
        </div>
      )}

      {runtime.installed.length > 0 && (
        <section className="flex flex-col gap-2" aria-label={labels.installed}>
          <h3 className="text-sm font-medium text-foreground">{labels.installed}</h3>
          {runtime.installed.map((item) => (
            <div
              key={`${item.version}-${item.variant}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
            >
              <div>
                <p className="text-sm text-foreground">
                  {item.version} · {formatVariantName(item.variant)}
                  {item.isDefault && <Badge className="ml-2">{labels.default}</Badge>}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatTransferSize(item.sizeBytes)}
                </p>
              </div>
              <div className="flex gap-2">
                {!item.isDefault && (
                  <Button variant="outline" size="sm" onClick={() => onMakeDefault(item)}>
                    {labels.makeDefault}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    onRemove({
                      runtimeId: item.runtimeId,
                      version: item.version,
                      variant: item.variant,
                    })
                  }
                >
                  {labels.remove}
                </Button>
              </div>
            </div>
          ))}
        </section>
      )}

      <details className="rounded-xl border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {labels.chooseVariant}
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">{labels.variantHelp}</p>
        <div className="mt-3 flex flex-col gap-2">
          {runtime.variants.map((variant) => (
            <label key={variant.variant} className="flex items-start gap-2 text-sm text-foreground">
              <input
                type="radio"
                name={`variant-${runtime.id}`}
                value={variant.variant}
                checked={chosen === variant.variant}
                onChange={() => onChoose(variant.variant)}
                className="mt-1 accent-primary"
              />
              <span>
                <span className="block font-medium">
                  {formatVariant(variant)} · {formatTransferSize(variant.sizeBytes)}
                  {variant.variant === runtime.recommendedVariant && ` · ${labels.recommendedTag}`}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {variantDescription(variant, labels)}
                </span>
              </span>
            </label>
          ))}
        </div>
      </details>
    </article>
  );
}

function progressId(runtimeId: string, variant: string): string {
  return `runtime-${runtimeId}-${variant}`;
}

function progressLabel(progress: DownloadProgress, labels: typeof en.views.runtimes): string {
  switch (progress.state.kind) {
    case "queued": return labels.queued;
    case "downloading": return labels.downloading;
    case "verifying": return labels.verifying;
    case "done": return labels.done;
    case "paused": return labels.paused;
    case "cancelled": return labels.cancelled;
    case "failed": return labels.failed(progress.state.message);
  }
}

function formatVariant(variant: RuntimeVariant): string {
  return formatVariantName(variant.variant);
}

function formatVariantName(variant: string): string {
  if (variant === "cpu") return "CPU";
  if (variant === "vulkan") return "Vulkan";
  return variant.toUpperCase().replace("CUDA-", "CUDA ");
}

function variantDescription(variant: RuntimeVariant, labels: typeof en.views.runtimes): string {
  if (variant.kind === "cpu") return labels.cpuDescription;
  if (variant.kind === "vulkan") return labels.vulkanDescription;
  return labels.cudaDescription(variant.variant.replace("cuda-", ""));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

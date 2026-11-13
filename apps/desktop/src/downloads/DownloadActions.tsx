import { Download, FolderOpen, Pause, Play, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { getStorageInfo, openModelFileFolder } from "@/api/api";
import type { HardwareProfile } from "@/api/types";
import { Button } from "@/components/primitives/button";
import { Progress } from "@/components/ui/display";
import { en } from "@/i18n/en";
import { percent, useDownloads } from "./useDownloads";
import { formatEta, formatTransferSize } from "./format";

export function DownloadActions({
  modelId,
  sizeBytes,
  profile,
  context,
  compact = false,
}: {
  modelId: string;
  sizeBytes: number;
  profile: HardwareProfile;
  context: number;
  compact?: boolean;
}) {
  const t = en.views.downloads;
  const downloads = useDownloads();
  const progress = downloads.byId(modelId);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    setWorking(true);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  const showInFolder = async () => {
    const storage = await getStorageInfo();
    const file = storage.modelFiles.find((item) => item.modelId === modelId);
    if (!file) throw new Error("The downloaded model file could not be found in managed storage.");
    await openModelFileFolder(file.path);
  };

  if (!progress) {
    return (
      <div className="flex flex-col items-start gap-1">
        <Button
          size={compact ? "sm" : "default"}
          onClick={() => void run(() => downloads.start(modelId, profile, context))}
          disabled={working}
        >
          <Download />
          {t.download(formatTransferSize(sizeBytes))}
        </Button>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
    );
  }

  const state = progress.state.kind;
  const stateLabel = {
    queued: t.queued,
    downloading: t.downloading,
    verifying: t.verifying,
    done: t.done,
    paused: t.paused,
    cancelled: t.cancelled,
    failed: t.failed,
  }[state];

  return (
    <div className="flex min-w-0 flex-col items-start gap-2">
      {state === "downloading" || state === "verifying" || state === "paused" || state === "failed" ? (
        <div className="w-full space-y-1">
          <div className="flex justify-between gap-2 text-xs">
            <span className="font-medium text-foreground">{stateLabel}</span>
            <div className="flex gap-2 tabular-nums text-muted-foreground">
              <span>{t.percent(Math.round(percent(progress)))}</span>
              <span>{t.downloaded(formatTransferSize(progress.done), formatTransferSize(progress.total))}</span>
            </div>
          </div>
          <Progress
            value={percent(progress)}
            label={`${stateLabel}: ${Math.round(percent(progress))}%`}
            size="sm"
          />
          {state === "downloading" && progress.bytesPerSec > 0 && (
            <p className="text-xs text-muted-foreground">
              {t.rate(formatTransferSize(progress.bytesPerSec))}
              {progress.etaSecs !== null && ` · ${t.eta(formatEta(progress.etaSecs))}`}
            </p>
          )}
        </div>
      ) : (
        <span className="text-sm font-medium text-foreground">{stateLabel}</span>
      )}
      {state === "failed" && (
        <p role="alert" className="text-xs text-destructive">{progress.state.message}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {state === "queued" || state === "downloading" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={working}
            onClick={() => void run(() => downloads.pause(modelId))}
          >
            <Pause />
            {t.pause}
          </Button>
        ) : null}
        {state === "paused" || state === "failed" || state === "cancelled" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={working}
            onClick={() => void run(() => downloads.resume(modelId))}
          >
            {state === "failed" ? <RotateCcw /> : <Play />}
            {state === "failed" ? t.retry : t.resume}
          </Button>
        ) : null}
        {state === "queued" || state === "downloading" || state === "paused" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={working}
            onClick={() => void run(() => downloads.cancel(modelId, true))}
          >
            <X />
            {t.cancel}
          </Button>
        ) : null}
        {state === "done" && (
          <Button
            variant="outline"
            size="sm"
            disabled={working}
            onClick={() => void run(showInFolder)}
          >
            <FolderOpen />
            {t.showInFolder}
          </Button>
        )}
      </div>
        {error && <p role="alert" className="text-xs text-destructive">{t.actionFailed(error)}</p>}
    </div>
  );
}

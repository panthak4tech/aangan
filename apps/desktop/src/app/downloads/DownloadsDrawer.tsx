import { Download, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { getModelFolder, openModelFolder } from "@/api/api";
import type { HardwareProfile } from "@/api/types";
import { Badge } from "@/components/primitives/badge";
import { Button } from "@/components/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/primitives/dialog";
import { en } from "@/i18n/en";
import { formatTransferSize } from "@/downloads/format";
import { DownloadActions } from "@/downloads/DownloadActions";
import { useDownloads } from "@/downloads/useDownloads";

export function DownloadsButton({ onClick }: { onClick: () => void }) {
  const downloads = useDownloads();
  const activeLabel = downloads.active.length > 0
    ? en.views.downloads.activeCount(downloads.active.length)
    : undefined;
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      aria-label={activeLabel
        ? `${en.views.downloads.title}, ${activeLabel}`
        : en.views.downloads.title}
    >
      <Download />
      {en.views.downloads.title}
      {downloads.active.length > 0 && <Badge variant="accent">{downloads.active.length}</Badge>}
    </Button>
  );
}

export function DownloadsDrawer({
  open,
  onOpenChange,
  profile,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: HardwareProfile;
}) {
  const t = en.views.downloads;
  const downloads = useDownloads();
  const [folder, setFolder] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    setFolderError(null);
    getModelFolder()
      .then((value) => mounted && setFolder(value))
      .catch((error: unknown) => mounted && setFolderError(errorMessage(error)));
    return () => {
      mounted = false;
    };
  }, [open]);

  const showFolder = async () => {
    setFolderError(null);
    try {
      await openModelFolder();
    } catch (error) {
      setFolderError(errorMessage(error));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="left-auto right-0 top-0 h-dvh max-h-screen w-full max-w-xl translate-x-0 translate-y-0 overflow-y-auto rounded-none p-6 sm:rounded-none">
        <DialogHeader className="pr-8 text-left">
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.description}</DialogDescription>
        </DialogHeader>
        {folder && <p className="break-all text-xs text-muted-foreground">{t.savedTo(folder)}</p>}
        {downloads.error && (
          <p role="alert" className="text-sm text-destructive">{t.loadFailed(downloads.error)}</p>
        )}
        {folderError && (
          <p role="alert" className="text-sm text-destructive">{t.openFolderFailed(folderError)}</p>
        )}
        <Button variant="outline" className="w-fit" onClick={() => void showFolder()}>
          <FolderOpen />
          {t.openFolder}
        </Button>
        {downloads.list.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t.empty}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {downloads.list.map((progress) => (
              <li key={progress.id} className="flex flex-col gap-3 rounded-xl border border-border p-4">
                <div>
                  <h3 className="break-all text-sm font-medium text-foreground">{progress.id}</h3>
                  {progress.state.kind === "queued" && (
                    <p className="text-xs text-muted-foreground">{t.queued} · {formatTransferSize(progress.total)}</p>
                  )}
                </div>
                <DownloadActions
                  modelId={progress.id}
                  sizeBytes={progress.total}
                  profile={profile}
                  context={4096}
                  compact
                />
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

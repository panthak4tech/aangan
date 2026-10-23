import { useToast } from "@/components/ui/toast-provider";
import { Button } from "@/components/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/primitives/dialog";
import licenseText from "../../../../../LICENSE?raw";
import { openAanganRepository, openThirdPartyNotices } from "@/api/api";
import { en } from "@/i18n/en";
import { ABOUT } from "./aboutInfo";
import { useAppVersion } from "./useAppVersion";

export function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const version = useAppVersion();
  const toast = useToast();
  const t = en.views.settings.about;

  const openRepository = async () => {
    try {
      await openAanganRepository();
    } catch (error) {
      toast(t.openRepositoryFailed(errorMessage(error)), { variant: "destructive" });
    }
  };

  const openNotices = async () => {
    try {
      await openThirdPartyNotices();
    } catch (error) {
      toast(t.openThirdPartyLicensesFailed(errorMessage(error)), { variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle>{ABOUT.name}</DialogTitle>
          <DialogDescription>
            {t.version} {version ?? "..."}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {ABOUT.licenseName}. {ABOUT.modelsNote}
        </p>
        <pre className="min-h-0 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border p-4 font-mono text-xs text-muted-foreground">
          {licenseText}
        </pre>
        <div className="flex flex-wrap gap-2">
          <Button variant="link" asChild>
            <a
              href={ABOUT.repoUrl}
              onClick={(event) => {
                event.preventDefault();
                void openRepository();
              }}
            >
              {t.projectRepository}
            </a>
          </Button>
          <Button variant="outline" onClick={() => void openNotices()}>
            {t.openThirdPartyLicenses}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

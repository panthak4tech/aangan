import { AlertCircle, ChevronDown, LoaderCircle, LockKeyhole, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getNetworkActivity } from "@/api/api";
import type { NetworkActivity } from "@/api/types";
import { Button } from "@/components/primitives/button";
import { Switch } from "@/components/primitives/switch";
import { en } from "@/i18n/en";
import { formatBytes } from "@/lib/format";
import { useNetState } from "@/net/useNetState";

export function NetworkStatusChip({
  canViewActivity,
  onShowActivity,
}: {
  canViewActivity: boolean;
  onShowActivity: () => void;
}) {
  const { state, loading, error, updateOfflineMode } = useNetState();
  const [open, setOpen] = useState(false);
  const [activity, setActivity] = useState<NetworkActivity[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [savingOfflineMode, setSavingOfflineMode] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const t = en.views.settings.network;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    setActivityLoading(true);
    setActivityError(null);
    void getNetworkActivity()
      .then((records) => {
        if (mounted) setActivity(records.filter((record) => record.ok === null));
      })
      .catch((cause: unknown) => {
        if (mounted) setActivityError(errorMessage(cause));
      })
      .finally(() => {
        if (mounted) setActivityLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [open, state?.active]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("keydown", closeOnEscape);
    popoverRef.current?.querySelector<HTMLElement>(
      'button:not(:disabled), [role="switch"]:not([aria-disabled="true"])',
    )?.focus();
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  const toggleOfflineMode = async (offlineMode: boolean) => {
    setSavingOfflineMode(true);
    setActionError(null);
    try {
      await updateOfflineMode(offlineMode);
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setSavingOfflineMode(false);
    }
  };

  const statusText = !state
    ? loading
      ? t.loading
      : t.statusUnavailable
    : state.offlineMode
      ? t.chipBlocked
      : state.active > 0
        ? t.chipActive(
            state.hosts[0] ?? t.unknownHost,
            Math.max(0, state.hosts.length - 1),
          )
        : t.chipIdle;
  const StatusIcon = !state
    ? error
      ? AlertCircle
      : LoaderCircle
    : state.offlineMode
      ? LockKeyhole
      : state.active > 0
        ? LoaderCircle
        : ShieldCheck;
  const activeTransfers = activity.filter((record) => record.ok === null);

  return (
    <div className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        ref={triggerRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="network-status-popover"
        disabled={loading && !state}
        onClick={() => setOpen((isOpen) => !isOpen)}
      >
        <span role="status" aria-live="polite" className="flex items-center gap-2">
          <StatusIcon
            className={`h-4 w-4 ${state && !state.offlineMode && state.active > 0 ? "animate-spin" : ""}`}
          />
          {statusText}
        </span>
        <ChevronDown aria-hidden="true" />
      </Button>
      {open && (
        <div
          id="network-status-popover"
          role="dialog"
          aria-label={t.popoverTitle}
          ref={popoverRef}
          className="absolute right-0 top-full z-50 mt-2 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-4 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg"
        >
          <div className="flex flex-col gap-1">
            <h2 className="font-medium">{t.popoverTitle}</h2>
            <p className="text-sm text-muted-foreground">{t.popoverDescription}</p>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
          {activityError && (
            <p role="alert" className="text-sm text-destructive">
              {t.activityLoadFailed(activityError)}
            </p>
          )}
          {activityLoading ? (
            <p role="status" className="text-sm text-muted-foreground">{t.loadingActivity}</p>
          ) : activeTransfers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.noActiveTransfers}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {activeTransfers.map((record) => (
                <li key={record.id} className="rounded-lg bg-muted px-3 py-2 text-sm">
                  <p className="font-medium">{t.purposeLabels[record.purpose]}</p>
                  <p className="break-all text-muted-foreground">
                    {record.host}
                    {record.via && ` → ${record.via}`}
                  </p>
                  <p className="text-muted-foreground">
                    {t.downloadedSoFar(formatBytes(record.bytesDown))}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-border pt-3 text-xs text-muted-foreground">
            {t.reassurance}
          </p>
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="network-offline-switch" className="text-sm font-medium">
              {t.offlineMode}
            </label>
            <Switch
              id="network-offline-switch"
              checked={state?.offlineMode ?? false}
              disabled={!state || savingOfflineMode}
              onCheckedChange={(checked) => void toggleOfflineMode(checked)}
            />
          </div>
          <Button
            type="button"
            variant="link"
            className="w-fit justify-start px-0"
            disabled={!canViewActivity}
            onClick={() => {
              setOpen(false);
              onShowActivity();
            }}
          >
            {t.seeActivity}
          </Button>
        </div>
      )}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

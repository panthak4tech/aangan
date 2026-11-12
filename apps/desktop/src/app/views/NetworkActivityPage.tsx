import { ArrowLeft, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { clearNetworkActivity, getNetworkActivity } from "@/api/api";
import type { NetworkActivity } from "@/api/types";
import { Button } from "@/components/primitives/button";
import { useToast } from "@/components/ui/toast-provider";
import { en } from "@/i18n/en";

export function NetworkActivityPage({ onBack }: { onBack: () => void }) {
  const t = en.views.settings.network;
  const [activity, setActivity] = useState<NetworkActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      setActivity(await getNetworkActivity());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clearActivity = async () => {
    setClearing(true);
    setError(null);
    try {
      await clearNetworkActivity();
      setActivity(await getNetworkActivity());
    } catch (cause) {
      const message = errorMessage(cause);
      setError(message);
      toast(t.clearFailed(message), { variant: "destructive" });
    } finally {
      setClearing(false);
    }
  };

  return (
    <section className="flex max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-3">
          <Button type="button" variant="ghost" className="w-fit px-0" onClick={onBack}>
            <ArrowLeft />
            {t.backToSettings}
          </Button>
          <div className="flex flex-col gap-1">
            <h1 className="font-display text-3xl font-semibold tracking-tight">{t.activityPageTitle}</h1>
            <p className="text-sm text-muted-foreground">{t.activityPageDescription}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw />
            {t.refreshActivity}
          </Button>
          <Button type="button" variant="outline" onClick={() => void clearActivity()} disabled={clearing}>
            <Trash2 />
            {t.clearActivity}
          </Button>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{t.activityLoadFailed(error)}</p>}
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">{t.loadingActivity}</p>
      ) : activity.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
          {t.emptyActivity}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[42rem] text-left text-sm">
            <thead className="border-b border-border bg-muted text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">{t.activityTime}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t.activityPurpose}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t.activityHost}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t.activitySize}</th>
                <th scope="col" className="px-4 py-3 font-medium">{t.activityResult}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {activity.map((record) => (
                <tr key={record.id}>
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                    <time dateTime={new Date(record.startedMs).toISOString()}>
                      {formatActivityTime(record.startedMs)}
                    </time>
                  </td>
                  <td className="px-4 py-3">{t.purposeLabels[record.purpose]}</td>
                  <td className="break-all px-4 py-3">
                    {record.host}
                    {record.via && (
                      <span className="block text-xs text-muted-foreground">
                        {t.viaHost(record.via)}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">{record.bytesDown.toLocaleString()} B</td>
                  <td className="px-4 py-3">
                    <span>{activityResult(record, t)}</span>
                    {record.note && record.note !== "ok" && record.ok !== null && (
                      <span className="block max-w-sm break-words text-xs text-muted-foreground">
                        {record.note}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function activityResult(
  record: NetworkActivity,
  labels: typeof en.views.settings.network,
): string {
  if (record.ok === null) return labels.inProgress;
  if (record.ok) return labels.activityOk;
  const note = record.note.toLowerCase();
  if (note.includes("blocked") || note.includes("offline")) return labels.activityBlocked;
  return labels.activityFailed;
}

function formatActivityTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" })
    .format(new Date(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

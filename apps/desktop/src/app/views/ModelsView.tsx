import { CircleSlash, LayoutGrid, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { recommendModels } from "@/api/api";
import type { HardwareProfile, Recommendation } from "@/api/types";
import { EmptyState } from "@/components/aangan/EmptyState";
import { ErrorState } from "@/components/aangan/ErrorState";
import { Button } from "@/components/primitives/button";
import { Input } from "@/components/primitives/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/primitives/select";
import { Skeleton } from "@/components/primitives/skeleton";
import { Switch } from "@/components/primitives/switch";
import { en } from "@/i18n/en";
import { ModelCard } from "../models/ModelCard";
import { CONTEXT_OPTIONS, filterRecs, nothingFitsComfortably } from "../models/fit";
import { EmptyView } from "./EmptyView";

interface Props {
  profile: HardwareProfile | null;
  onOpenModel?: (rec: Recommendation) => void;
}

const SHOW_WONT_FIT_KEY = "aangan.models.showWontFit";

export function ModelsView({ profile, onOpenModel }: Props) {
  const t = en.views.models;
  const [context, setContext] = useState<number>(4096);
  const [query, setQuery] = useState("");
  const [showWontFit, setShowWontFit] = useState(
    () => window.localStorage.getItem(SHOW_WONT_FIT_KEY) === "true",
  );
  const [recs, setRecs] = useState<Recommendation[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!profile) return;
    let live = true;
    setRecs(null);
    setError(false);
    recommendModels(profile, context)
      .then((r) => live && setRecs(r))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [profile, context, attempt]);

  const visible = useMemo(
    () => filterRecs(recs ?? [], query, showWontFit),
    [recs, query, showWontFit],
  );
  const wontFitLabel = `${t.showWontFit}${visible.wontFitCount > 0 ? ` (${visible.wontFitCount})` : ""}`;

  if (!profile) return <EmptyView title={t.title} body={t.empty} icon={LayoutGrid} />;

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-3xl font-semibold tracking-tight">{t.title}</h1>
        <p className="text-sm text-muted-foreground">{t.subtitle}</p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t.context}</span>
          <Select value={String(context)} onValueChange={(v) => setContext(Number(v))}>
            <SelectTrigger className="w-40 bg-card" aria-label={t.context} title={t.contextHint}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTEXT_OPTIONS.map((c) => (
                <SelectItem key={c} value={String(c)}>
                  {t.contextOption(c / 1024)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.search}
            aria-label={t.search}
            className="bg-card pl-9"
          />
        </div>
        <label className="flex h-9 items-center gap-2 text-sm text-foreground">
          <Switch
            checked={showWontFit}
            onCheckedChange={(checked) => {
              window.localStorage.setItem(SHOW_WONT_FIT_KEY, String(checked));
              setShowWontFit(checked);
            }}
            aria-label={wontFitLabel}
          />
          <span>{wontFitLabel}</span>
        </label>
      </div>
      {recs && visible.wontFitCount === 0 && (
        <p className="text-sm text-muted-foreground">{t.everyModelFits}</p>
      )}

      {error && (
        <ErrorState
          title={t.loadErrorTitle}
          body={t.loadError}
          actions={<Button onClick={() => setAttempt((a) => a + 1)}>{t.retry}</Button>}
        />
      )}

      {!recs && !error && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-64 rounded-xl" />
          ))}
        </div>
      )}

      {recs && nothingFitsComfortably(recs) && (
        <EmptyState
          icon={CircleSlash}
          title={t.nothingFits.title}
          body={t.nothingFits.body}
          tips={t.nothingFits.tips}
        />
      )}

      {recs
        && visible.fitting.length === 0
        && visible.wontFit.length === 0
        && !nothingFitsComfortably(recs) && (
        <p className="text-sm text-muted-foreground">{t.noMatch}</p>
      )}

      {recs && visible.fitting.length > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.fitting.map((r) => (
            <ModelCard key={r.model.id} rec={r} profile={profile} onOpen={() => onOpenModel?.(r)} />
          ))}
        </div>
      )}

      {recs && visible.wontFit.length > 0 && (
        <section aria-labelledby="wont-fit-heading" className="flex flex-col gap-3">
          <h2 id="wont-fit-heading" className="font-display text-xl font-semibold">
            {t.wontFitTitle}
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {visible.wontFit.map((r) => (
              <ModelCard key={r.model.id} rec={r} profile={profile} onOpen={() => onOpenModel?.(r)} />
            ))}
          </div>
        </section>
      )}
    </section>
  );
}

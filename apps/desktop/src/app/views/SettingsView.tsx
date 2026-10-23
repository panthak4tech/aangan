import { Database, FolderOpen, Info, Languages, Monitor, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { AboutDialog } from "@/app/notices/NoticesDialog";
import {
  APP_INFO,
  getAppPaths,
  getCatalogInfo,
  resetCatalog,
  setCatalogRefreshConsent,
  setSubscribedFamilies,
} from "@/api/api";
import type { AppPaths, CatalogInfo } from "@/api/types";
import { SpecRow } from "@/components/aangan/SystemSpecCard";
import { Badge } from "@/components/primitives/badge";
import { Button } from "@/components/primitives/button";
import { Card } from "@/components/primitives/card";
import { Checkbox } from "@/components/primitives/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/primitives/radio-group";
import { Skeleton } from "@/components/primitives/skeleton";
import { useToast } from "@/components/ui/toast-provider";
import { cn } from "@/lib/utils";
import { en } from "@/i18n/en";
import { useTheme } from "@/theme/useTheme";
import { isTheme } from "@/theme/theme";

function SettingsSection({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-3 p-5 shadow-none">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
          <Icon className="h-5 w-5" />
        </span>
        <h2 className="font-display text-base font-semibold text-card-foreground">{title}</h2>
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </Card>
  );
}

export function SettingsView() {
  const t = en.views.settings;
  const [lang, setLang] = useState<string>(APP_INFO.languages[0].code);
  const [theme, setTheme] = useTheme();
  const [appPaths, setAppPaths] = useState<AppPaths | null>(null);
  const [pathsLoading, setPathsLoading] = useState(true);
  const [pathsError, setPathsError] = useState<string | null>(null);
  const [copyingPath, setCopyingPath] = useState(false);
  const [noticesOpen, setNoticesOpen] = useState(false);
  const [catalogInfo, setCatalogInfo] = useState<CatalogInfo | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogSaving, setCatalogSaving] = useState(false);
  const [catalogResetting, setCatalogResetting] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let mounted = true;
    void getAppPaths()
      .then((paths) => {
        if (mounted) setAppPaths(paths);
      })
      .catch((error: unknown) => {
        if (mounted) setPathsError(errorMessage(error));
      })
      .finally(() => {
        if (mounted) setPathsLoading(false);
      });

    void getCatalogInfo()
      .then((info) => {
        if (mounted) setCatalogInfo(info);
      })
      .catch((error: unknown) => {
        if (mounted) setCatalogError(errorMessage(error));
      })
      .finally(() => {
        if (mounted) setCatalogLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const updateFamilies = async (family: string, subscribed: boolean) => {
    if (!catalogInfo) return;
    const families = subscribed
      ? [...catalogInfo.subscribed_families, family]
      : catalogInfo.subscribed_families.filter((item) => item !== family);
    setCatalogSaving(true);
    try {
      setCatalogInfo(await setSubscribedFamilies(families));
    } catch (error) {
      toast(t.catalog.saveFailed(errorMessage(error)), { variant: "destructive" });
    } finally {
      setCatalogSaving(false);
    }
  };

  const updateRefreshConsent = async (alwaysAllowed: boolean) => {
    if (!catalogInfo) return;
    setCatalogSaving(true);
    try {
      await setCatalogRefreshConsent(alwaysAllowed);
      setCatalogInfo(await getCatalogInfo());
    } catch (error) {
      toast(t.catalog.saveFailed(errorMessage(error)), { variant: "destructive" });
    } finally {
      setCatalogSaving(false);
    }
  };

  const resetCachedCatalog = async () => {
    setCatalogResetting(true);
    try {
      setCatalogInfo(await resetCatalog());
      toast(t.catalog.resetComplete, { variant: "success" });
    } catch (error) {
      toast(t.catalog.resetFailed(errorMessage(error)), { variant: "destructive" });
    } finally {
      setCatalogResetting(false);
    }
  };

  const openDataFolder = async () => {
    if (!appPaths) return;
    try {
      await openPath(appPaths.data_dir);
    } catch (error) {
      toast(t.data.openFailed(errorMessage(error)), { variant: "destructive" });
    }
  };

  const copyDataPath = async () => {
    if (!appPaths) return;
    setCopyingPath(true);
    try {
      await navigator.clipboard.writeText(appPaths.data_dir);
      toast(t.data.copied, { variant: "success" });
    } catch (error) {
      toast(t.data.copyFailed(errorMessage(error)), { variant: "destructive" });
    } finally {
      setCopyingPath(false);
    }
  };

  return (
    <section className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-3xl font-semibold tracking-tight">{t.title}</h1>
        <p className="text-sm text-muted-foreground">{t.subtitle}</p>
      </div>

      <SettingsSection icon={ShieldCheck} title={t.privacy.title}>
        <p className="text-sm text-muted-foreground">{t.privacy.body}</p>
      </SettingsSection>

      <SettingsSection icon={FolderOpen} title={t.data.title}>
        <p className="text-sm text-muted-foreground">{t.data.body}</p>
        {pathsLoading ? (
          <Skeleton role="status" aria-label={t.data.loading} className="h-8 w-full" />
        ) : appPaths ? (
          <code className="select-all break-all rounded-lg bg-muted px-3 py-2 font-mono text-xs text-foreground">
            {appPaths.data_dir}
          </code>
        ) : (
          <p role="alert" className="text-sm text-destructive">
            {t.data.readFailed(pathsError ?? "unknown error")}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={openDataFolder} disabled={!appPaths}>
            <FolderOpen />
            {t.data.openFolder}
          </Button>
          <Button variant="outline" onClick={copyDataPath} disabled={!appPaths || copyingPath}>
            {t.data.copyPath}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t.data.hint}</p>
      </SettingsSection>

      <SettingsSection icon={Database} title={t.catalog.title}>
        <p className="text-sm text-muted-foreground">{t.catalog.body}</p>
        <p className="text-sm text-muted-foreground">{t.catalog.source}</p>
        {catalogLoading ? (
          <Skeleton role="status" aria-label={t.catalog.loading} className="h-8 w-full" />
        ) : catalogError ? (
          <p role="alert" className="text-sm text-destructive">
            {t.catalog.loadFailed(catalogError)}
          </p>
        ) : catalogInfo ? (
          <>
            <p className="text-sm text-muted-foreground">
              {t.catalog.updated(formatCatalogDate(catalogInfo.generated_at))}
            </p>
            {catalogInfo.warning && (
              <p role="alert" className="text-sm text-destructive">{catalogInfo.warning}</p>
            )}
            <fieldset className="flex flex-col gap-2" disabled={catalogSaving}>
              <legend className="text-sm font-medium text-foreground">{t.catalog.families}</legend>
              {catalogInfo.families.map((family) => (
                <label key={family} className="flex items-center gap-2 text-sm text-foreground">
                  <Checkbox
                    checked={catalogInfo.subscribed_families.includes(family)}
                    onCheckedChange={(checked) => void updateFamilies(family, checked === true)}
                  />
                  {family}
                </label>
              ))}
            </fieldset>
            <label className="flex items-start gap-2 text-sm text-foreground">
              <Checkbox
                checked={catalogInfo.refresh_catalog_always_allowed}
                disabled={catalogSaving}
                onCheckedChange={(checked) => void updateRefreshConsent(checked === true)}
              />
              <span>{t.catalog.alwaysAllow}</span>
            </label>
            <Button
              variant="outline"
              className="w-fit"
              onClick={() => void resetCachedCatalog()}
              disabled={catalogResetting || catalogLoading}
            >
              {t.catalog.reset}
            </Button>
          </>
        ) : null}
      </SettingsSection>

      <SettingsSection icon={Languages} title={t.language.title}>
        <RadioGroup value={lang} onValueChange={setLang} className="gap-3">
          {APP_INFO.languages.map((l) => (
            <label
              key={l.code}
              className={cn("flex items-center gap-3 text-sm", !l.available && "cursor-not-allowed")}
            >
              <RadioGroupItem value={l.code} disabled={!l.available} />
              <span className={l.available ? "text-foreground" : "text-muted-foreground"}>
                {t.language.options[l.code]}
              </span>
              {!l.available && <Badge variant="unknown">{t.language.comingSoon}</Badge>}
            </label>
          ))}
        </RadioGroup>
      </SettingsSection>

      <SettingsSection icon={Monitor} title={t.appearance.title}>
        <p className="text-sm text-muted-foreground">{t.appearance.description}</p>
        <RadioGroup
          value={theme}
          onValueChange={(value) => {
            if (isTheme(value)) setTheme(value);
          }}
          className="gap-3"
          aria-label={t.appearance.title}
        >
          {(["system", "light", "dark"] as const).map((option) => (
            <label key={option} className="flex items-center gap-3 text-sm text-foreground">
              <RadioGroupItem value={option} />
              <span>{t.appearance.options[option]}</span>
            </label>
          ))}
        </RadioGroup>
      </SettingsSection>

      <SettingsSection icon={Info} title={t.about.title}>
        <dl className="flex flex-col gap-2.5">
          <SpecRow label={t.about.version} value={APP_INFO.version} />
          <SpecRow label={t.about.license} value={APP_INFO.license} />
        </dl>
        <button
          type="button"
          className="w-fit text-sm font-medium text-primary underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-haspopup="dialog"
          onClick={() => setNoticesOpen(true)}
        >
          {t.about.notices}
        </button>
      </SettingsSection>
      <AboutDialog open={noticesOpen} onOpenChange={setNoticesOpen} />
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatCatalogDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

import {
  Database,
  FolderOpen,
  Globe,
  HardDrive,
  Info,
  Languages,
  Monitor,
  ShieldCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { AboutDialog } from "@/app/notices/NoticesDialog";
import {
  APP_INFO,
  chooseModelFolder,
  deleteStorageFile,
  getAppPaths,
  getCatalogInfo,
  getStorageInfo,
  getNetworkState,
  listenNetworkState,
  openNetworkDocs as openNetworkDocsCommand,
  openModelFileFolder,
  openModelFolder,
  resetCatalog,
  setCatalogRefreshConsent,
  setOfflineMode,
  setModelFolder,
  setSubscribedFamilies,
} from "@/api/api";
import type { AppPaths, CatalogInfo, NetworkState, StorageFile, StorageInfo } from "@/api/types";
import { SpecRow } from "@/components/aangan/SystemSpecCard";
import { Badge } from "@/components/primitives/badge";
import { Button } from "@/components/primitives/button";
import { Card } from "@/components/primitives/card";
import { Checkbox } from "@/components/primitives/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/primitives/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/primitives/radio-group";
import { Skeleton } from "@/components/primitives/skeleton";
import { useToast } from "@/components/ui/toast-provider";
import { cn } from "@/lib/utils";
import { en } from "@/i18n/en";
import { useTheme } from "@/theme/useTheme";
import { isTheme } from "@/theme/theme";
import { NetworkActivityPage } from "./NetworkActivityPage";
import { formatTransferSize } from "@/downloads/format";

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

export function SettingsView({
  openNetworkActivity = false,
  onCloseNetworkActivity,
  onDownloadDeleted,
}: {
  openNetworkActivity?: boolean;
  onCloseNetworkActivity?: () => void;
  onDownloadDeleted?: (id: string) => void;
} = {}) {
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
  const [networkState, setNetworkState] = useState<NetworkState | null>(null);
  const [networkLoading, setNetworkLoading] = useState(true);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [networkSaving, setNetworkSaving] = useState(false);
  const [localNetworkActivityOpen, setLocalNetworkActivityOpen] = useState(false);
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [storageLoading, setStorageLoading] = useState(true);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageSaving, setStorageSaving] = useState(false);
  const [deletingFile, setDeletingFile] = useState<StorageFile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
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

    void getStorageInfo()
      .then((info) => {
        if (mounted) setStorageInfo(info);
      })
      .catch((error: unknown) => {
        if (mounted) setStorageError(errorMessage(error));
      })
      .finally(() => {
        if (mounted) setStorageLoading(false);
      });

    let receivedNetworkEvent = false;
    let unlisten: (() => void) | undefined;
    void listenNetworkState((state) => {
      if (!mounted) return;
      receivedNetworkEvent = true;
      setNetworkError(null);
      setNetworkState(state);
    })
      .then((stopListening) => {
        if (mounted) unlisten = stopListening;
        else stopListening();
      })
      .catch((error: unknown) => {
        if (mounted) setNetworkError(errorMessage(error));
      });

    void getNetworkState()
      .then((state) => {
        if (!mounted) return;
        if (!receivedNetworkEvent) setNetworkState(state);
      })
      .catch((error: unknown) => {
        if (mounted) setNetworkError(errorMessage(error));
      })
      .finally(() => {
        if (mounted) setNetworkLoading(false);
      });

    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  const updateOfflineMode = async (offlineMode: boolean) => {
    setNetworkSaving(true);
    try {
      setNetworkState(await setOfflineMode(offlineMode));
      setNetworkError(null);
    } catch (error) {
      toast(t.network.offlineSaveFailed(errorMessage(error)), { variant: "destructive" });
    } finally {
      setNetworkSaving(false);
    }
  };

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

  const chooseStorageFolder = async () => {
    setStorageSaving(true);
    setStorageError(null);
    try {
      const selected = await chooseModelFolder();
      if (!selected) return;
      const folder = await setModelFolder(selected);
      setStorageInfo((current) => current ? { ...current, modelFolder: folder } : current);
    } catch (error) {
      setStorageError(t.storage.saveFailed(errorMessage(error)));
    } finally {
      setStorageSaving(false);
    }
  };

  const openStorageFolder = async () => {
    setStorageError(null);
    try {
      await openModelFolder();
    } catch (error) {
      setStorageError(t.storage.openFailed(errorMessage(error)));
    }
  };

  const revealStorageFile = async (file: StorageFile) => {
    setStorageError(null);
    try {
      await openModelFileFolder(file.path);
    } catch (error) {
      setStorageError(t.storage.showInFolderFailed(errorMessage(error)));
    }
  };

  const confirmDeleteStorageFile = async () => {
    if (!deletingFile) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteStorageFile(deletingFile.path, deletingFile.modelId);
      if (deletingFile.modelId) onDownloadDeleted?.(deletingFile.modelId);
      setDeletingFile(null);
      try {
        setStorageInfo(await getStorageInfo());
        setStorageError(null);
      } catch (error) {
        setStorageError(t.storage.loadFailed(errorMessage(error)));
      }
    } catch (error) {
      setDeleteError(t.storage.deleteFailed(errorMessage(error)));
    } finally {
      setDeleting(false);
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

  const openNetworkDocs = async () => {
    try {
      await openNetworkDocsCommand();
    } catch (error) {
      toast(t.privacy.networkDocsOpenFailed(errorMessage(error)), { variant: "destructive" });
    }
  };

  const closeNetworkActivity = () => {
    setLocalNetworkActivityOpen(false);
    onCloseNetworkActivity?.();
  };

  if (openNetworkActivity || localNetworkActivityOpen) {
    return <NetworkActivityPage onBack={closeNetworkActivity} />;
  }

  return (
    <section className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-3xl font-semibold tracking-tight">{t.title}</h1>
        <p className="text-sm text-muted-foreground">{t.subtitle}</p>
      </div>

      <SettingsSection icon={ShieldCheck} title={t.privacy.title}>
        <p className="text-sm text-muted-foreground">{t.privacy.body}</p>
        {networkError && (
          <p role="alert" className="text-sm text-destructive">
            {t.network.loadFailed(networkError)}
          </p>
        )}
        {networkLoading ? (
          <Skeleton role="status" aria-label={t.network.loading} className="h-8 w-full" />
        ) : networkState ? (
          <label className="flex items-start gap-2 text-sm text-foreground">
            <Checkbox
              checked={networkState.offlineMode}
              disabled={networkSaving}
              onCheckedChange={(checked) => void updateOfflineMode(checked === true)}
            />
            <span>
              <span className="block font-medium">{t.network.offlineMode}</span>
              <span className="block text-muted-foreground">
                {t.network.offlineDescription}
              </span>
            </span>
          </label>
        ) : null}
        <Button
          type="button"
          variant="outline"
          className="w-fit"
          onClick={() => setLocalNetworkActivityOpen(true)}
        >
          {t.network.seeActivity}
        </Button>
        <Button
          type="button"
          variant="link"
          className="w-fit justify-start px-0"
          onClick={() => void openNetworkDocs()}
        >
          {t.privacy.networkDetails}
        </Button>
      </SettingsSection>

      <SettingsSection icon={Globe} title={t.network.title}>
        <p className="text-sm text-muted-foreground">{t.network.body}</p>
        {networkState && (
          <div className="flex flex-col gap-1 text-sm text-muted-foreground" aria-live="polite">
            <p>{networkState.offlineMode ? t.network.offlineOn : t.network.offlineOff}</p>
            <p>{t.network.activeRequests(networkState.active)}</p>
            {networkState.hosts.length > 0 && (
              <p>{t.network.activeHosts(networkState.hosts.join(", "))}</p>
            )}
            {networkState.active > 0 && (
              <p>{t.network.activeDownload(formatBytes(networkState.bytesDown))}</p>
            )}
          </div>
        )}
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

      <SettingsSection icon={HardDrive} title={t.storage.title}>
        <p className="text-sm text-muted-foreground">{t.storage.body}</p>
        {storageLoading ? (
          <Skeleton role="status" aria-label={t.storage.loading} className="h-8 w-full" />
        ) : storageInfo ? (
          <>
            <p className="text-sm text-muted-foreground">{t.storage.folder}</p>
            <code className="select-all break-all rounded-lg bg-muted px-3 py-2 font-mono text-xs text-foreground">
              {storageInfo.modelFolder}
            </code>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void chooseStorageFolder()} disabled={storageSaving}>
                {t.storage.chooseFolder}
              </Button>
              <Button variant="outline" onClick={() => void openStorageFolder()}>
                <FolderOpen />
                {t.storage.openFolder}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t.storage.total(formatTransferSize(storageInfo.totalBytes))}</p>
            <p className="text-xs text-muted-foreground">
              {t.storage.catalogCache(formatTransferSize(storageInfo.catalogCacheBytes))}
            </p>
            <StorageFileList
              title={t.storage.models}
              empty={t.storage.emptyModels}
              files={storageInfo.modelFiles}
              onReveal={(file) => void revealStorageFile(file)}
              onDelete={(file) => {
                setDeleteError(null);
                setDeletingFile(file);
              }}
              deleteLabel={t.storage.delete}
              revealLabel={t.storage.showInFolder}
            />
            <StorageFileList
              title={t.storage.partials}
              empty={t.storage.emptyPartials}
              files={storageInfo.incompleteDownloads}
              onReveal={(file) => void revealStorageFile(file)}
              onDelete={(file) => {
                setDeleteError(null);
                setDeletingFile(file);
              }}
              deleteLabel={t.storage.delete}
              revealLabel={t.storage.showInFolder}
            />
          </>
        ) : (
          <p role="alert" className="text-sm text-destructive">
            {t.storage.loadFailed(storageError ?? "unknown error")}
          </p>
        )}
        {storageError && storageInfo && (
          <p role="alert" className="text-sm text-destructive">{storageError}</p>
        )}
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
              {catalogInfo.signature_verified && ` · ${t.catalog.signatureVerified}`}
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
      <Dialog
        open={!!deletingFile}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeletingFile(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.storage.deleteTitle}</DialogTitle>
            <DialogDescription>
              {t.storage.deleteDescription(deletingFile?.name ?? "")}
            </DialogDescription>
          </DialogHeader>
          {deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeletingFile(null)}
              disabled={deleting}
            >
              {t.storage.cancelDelete}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDeleteStorageFile()}
              disabled={deleting}
            >
              {t.storage.confirmDelete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function StorageFileList({
  title,
  empty,
  files,
  onReveal,
  onDelete,
  deleteLabel,
  revealLabel,
}: {
  title: string;
  empty: string;
  files: StorageFile[];
  onReveal: (file: StorageFile) => void;
  onDelete: (file: StorageFile) => void;
  deleteLabel: string;
  revealLabel: string;
}) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {files.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {files.map((file) => (
            <li
              key={file.path}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
            >
              <div className="min-w-0">
                <p className="break-all text-sm text-foreground">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatTransferSize(file.sizeBytes)}</p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => onReveal(file)}>
                  <FolderOpen />
                  {revealLabel}
                </Button>
                <Button variant="outline" size="sm" onClick={() => onDelete(file)}>
                  {deleteLabel}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatCatalogDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unitIndex = -1;
  do {
    amount /= 1024;
    unitIndex += 1;
  } while (amount >= 1024 && unitIndex < units.length - 1);
  return `${amount.toFixed(amount < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

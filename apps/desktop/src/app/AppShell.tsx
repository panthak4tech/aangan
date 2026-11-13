import { useState } from "react";
import mark from "@/assets/brand/aangan-mark.png";
import { scanHardware } from "@/api/api";
import type { HardwareProfile, Recommendation } from "@/api/types";
import { TooltipProvider } from "@/components/primitives/tooltip";
import { ToastProvider } from "@/components/ui/toast-provider";
import { DownloadsButton, DownloadsDrawer } from "./downloads/DownloadsDrawer";
import { DownloadsProvider, useDownloads } from "../downloads/useDownloads";
import { en } from "@/i18n/en";
import { DevPresetSwitch } from "./DevPresetSwitch";
import { NavRail, type View } from "./NavRail";
import { ModelsView } from "./views/ModelsView";
import { ScanView } from "./views/ScanView";
import { SettingsView } from "./views/SettingsView";
import { ModelDetailDialog } from "./models/ModelDetailDialog";
import { FirstRunWizard } from "./wizard/FirstRunWizard";
import { NetworkStatusChip } from "./NetworkStatusChip";

export function AppShell() {
  return (
    <DownloadsProvider>
      <AppShellContent />
    </DownloadsProvider>
  );
}

function AppShellContent() {
  const [view, setView] = useState<View>("scan");
  // React state only: the wizard reappears on every app start for now.
  const [onboarded, setOnboarded] = useState(false);
  const [profile, setProfile] = useState<HardwareProfile | null>(null);
  const [measure, setMeasure] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState(false);
  const [selected, setSelected] = useState<Recommendation | null>(null);
  const [networkActivityOpen, setNetworkActivityOpen] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const downloads = useDownloads();

  const changeView = (nextView: View) => {
    setView(nextView);
    if (nextView !== "settings") setNetworkActivityOpen(false);
  };

  const openNetworkActivity = () => {
    setView("settings");
    setNetworkActivityOpen(true);
  };

  const rescan = async () => {
    setScanning(true);
    setScanError(false);
    try {
      setProfile(await scanHardware(measure));
    } catch {
      setScanError(true);
    } finally {
      setScanning(false);
    }
  };

  return (
    <ToastProvider>
      <TooltipProvider delayDuration={200}>
        <div className="flex h-screen w-full min-w-[900px] overflow-hidden bg-background text-foreground">
          {onboarded && <NavRail view={view} onChange={changeView} />}
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-8">
              <div className="flex items-center gap-3">
                {!onboarded && <img src={mark} alt="" width={40} height={40} className="h-10 w-10 rounded-xl" />}
                <div className="flex items-baseline gap-3">
                  <span className="font-display text-base font-semibold">{en.app.name}</span>
                  <span className="text-xs text-muted-foreground">{en.app.tagline}</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <NetworkStatusChip
                  canViewActivity={onboarded}
                  onShowActivity={openNetworkActivity}
                />
                {onboarded && profile && (
                  <DownloadsButton onClick={() => setDownloadsOpen(true)} />
                )}
                <DevPresetSwitch />
              </div>
            </header>
            <main className="flex flex-1 flex-col overflow-auto p-8">
              <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col">
                {!onboarded ? (
                  <FirstRunWizard
                    onComplete={(p, m) => {
                      setProfile(p);
                      setMeasure(m);
                      setOnboarded(true);
                      setView("models");
                    }}
                  />
                ) : (
                  <>
                    {view === "scan" && (
                      <ScanView profile={profile} scanning={scanning} scanError={scanError} onRescan={rescan} />
                    )}
                    {view === "models" && <ModelsView profile={profile} onOpenModel={setSelected} />}
                    {view === "settings" && (
                      <SettingsView
                        openNetworkActivity={networkActivityOpen}
                        onCloseNetworkActivity={() => setNetworkActivityOpen(false)}
                        onDownloadDeleted={downloads.forget}
                      />
                    )}
                  </>
                )}
              </div>
            </main>
            <ModelDetailDialog rec={selected} profile={profile} onClose={() => setSelected(null)} />
            {profile && (
              <DownloadsDrawer
                open={downloadsOpen}
                onOpenChange={setDownloadsOpen}
                profile={profile}
              />
            )}
          </div>
        </div>
      </TooltipProvider>
    </ToastProvider>
  );
}

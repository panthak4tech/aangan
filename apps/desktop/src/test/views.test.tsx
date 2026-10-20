import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyHardwareReport,
  getAppPaths,
  recommendModels,
  saveHardwareReport,
  scanHardware,
} from "@/api/api";
import { MODELS, PRESETS } from "@/api/presets";
import { rankModels } from "@/api/estimate";
import { en } from "@/i18n/en";
import { ModelsView } from "@/app/views/ModelsView";
import { ScanView } from "@/app/views/ScanView";
import { SettingsView } from "@/app/views/SettingsView";
import { FirstRunWizard } from "@/app/wizard/FirstRunWizard";
import { TooltipProvider } from "@/components/primitives/tooltip";
import { ToastProvider } from "@/components/ui/toast-provider";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}));
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

vi.mock("@/api/api", () => ({
  copyHardwareReport: vi.fn(),
  getAppPaths: vi.fn(),
  recommendModels: vi.fn(),
  saveHardwareReport: vi.fn(),
  scanHardware: vi.fn(),
  APP_INFO: {
    version: "0.2.0",
    license: "MIT",
    languages: [
      { code: "en", available: true },
      { code: "hi", available: false },
    ],
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.removeItem("aangan.models.showWontFit");
  vi.mocked(openPath).mockResolvedValue();
  vi.mocked(revealItemInDir).mockResolvedValue();
});

function renderScanView(profile = PRESETS.laptop8_cpu) {
  return render(
    <ToastProvider>
      <ScanView
        profile={profile}
        scanning={false}
        scanError={false}
        onRescan={vi.fn()}
      />
    </ToastProvider>,
  );
}

describe("ModelsView", () => {
  it("shows the scan-first empty state when no hardware profile exists", () => {
    render(
      <TooltipProvider>
        <ModelsView profile={null} />
      </TooltipProvider>,
    );

    expect(screen.getByText(en.views.models.title)).toBeInTheDocument();
    expect(screen.getByText(en.views.models.empty)).toBeInTheDocument();
  });

  it("loads recommendations and filters cards by searchable model metadata", async () => {
    vi.mocked(recommendModels).mockResolvedValue(
      rankModels(PRESETS.desktop_3060, MODELS, 4096),
    );
    render(
      <TooltipProvider>
        <ModelsView profile={PRESETS.desktop_3060} />
      </TooltipProvider>,
    );

    expect(await screen.findByText("Qwen2.5 7B Instruct")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: en.views.models.search }), {
      target: { value: "coding" },
    });
    expect(screen.getByText("Qwen2.5 7B Instruct")).toBeInTheDocument();
    expect(screen.queryByText("Qwen2.5 0.5B Instruct")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: en.views.models.search }), {
      target: { value: "no such model" },
    });
    expect(screen.getByText(en.views.models.noMatch)).toBeInTheDocument();
    expect(recommendModels).toHaveBeenCalledWith(PRESETS.desktop_3060, 4096);
  });

  it("reveals non-fitting models in a separate section with a keyboard-operable switch", async () => {
    const recommendations = rankModels(PRESETS.desktop_3060, MODELS, 4096).map((item, index) =>
      index === 0
        ? {
            ...item,
            estimate: {
              ...item.estimate,
              fit: "wont_fit" as const,
              placement: { kind: "no_fit" as const },
              memory_required_bytes: 8 * 1024 ** 3,
              reasons: ["reason_no_fit"],
            },
          }
        : { ...item, estimate: { ...item.estimate, fit: "too_slow" as const } },
    );
    vi.mocked(recommendModels).mockResolvedValue(recommendations);
    const { unmount } = render(
      <TooltipProvider>
        <ModelsView profile={PRESETS.laptop8_cpu} />
      </TooltipProvider>,
    );

    expect(await screen.findByText(en.views.models.nothingFits.title)).toBeInTheDocument();
    expect(screen.queryByText(recommendations[0].model.name)).not.toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Show models that won't fit (1)" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    toggle.focus();
    await userEvent.setup().keyboard(" ");
    await waitFor(() =>
      expect(screen.getByText(recommendations[0].model.name)).toBeInTheDocument(),
    );
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(window.localStorage.getItem("aangan.models.showWontFit")).toBe("true");
    expect(screen.getByRole("heading", { name: en.views.models.wontFitTitle })).toBeInTheDocument();
    expect(screen.getByText(/Needs .* — this PC has .* system memory available\./)).toBeInTheDocument();

    unmount();
    render(
      <TooltipProvider>
        <ModelsView profile={PRESETS.laptop8_cpu} />
      </TooltipProvider>,
    );
    expect(await screen.findByRole("switch", { name: "Show models that won't fit (1)" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("explains when every catalog model fits without adding a zero count", async () => {
    vi.mocked(recommendModels).mockResolvedValue(
      rankModels(PRESETS.desktop_3060, MODELS, 4096).map((item) => ({
        ...item,
        estimate: { ...item.estimate, fit: "good" as const },
      })),
    );
    render(
      <TooltipProvider>
        <ModelsView profile={PRESETS.desktop_3060} />
      </TooltipProvider>,
    );

    expect(await screen.findByText(en.views.models.everyModelFits)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: en.views.models.showWontFit })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("renders a retry action after recommendation failure", async () => {
    vi.mocked(recommendModels)
      .mockRejectedValueOnce(new Error("ranking failed"))
      .mockResolvedValueOnce(rankModels(PRESETS.desktop_3060, MODELS, 4096));
    render(
      <TooltipProvider>
        <ModelsView profile={PRESETS.desktop_3060} />
      </TooltipProvider>,
    );

    expect(await screen.findByText(en.views.models.loadErrorTitle)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.views.models.retry }));
    expect(await screen.findByText("Qwen2.5 7B Instruct")).toBeInTheDocument();
    expect(recommendModels).toHaveBeenCalledTimes(2);
  });
});

describe("ScanView", () => {
  it("shows the empty state without a profile and the scanning state while probing", () => {
    const onRescan = vi.fn();
    const { rerender } = render(
      <ToastProvider>
        <ScanView profile={null} scanning={false} scanError={false} onRescan={onRescan} />
      </ToastProvider>,
    );
    expect(screen.getByText(en.views.scan.empty)).toBeInTheDocument();

    rerender(
      <ToastProvider>
        <ScanView profile={PRESETS.desktop_3060} scanning scanError onRescan={onRescan} />
      </ToastProvider>,
    );
    expect(screen.getByLabelText(en.views.scan.scanning)).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByText(en.views.scan.scanFailed)).toBeInTheDocument();
  });

  it("renders CPU, integrated GPU, memory, storage and measurement details", () => {
    render(
      <ToastProvider>
        <ScanView
          profile={PRESETS.laptop16_igpu}
          scanning={false}
          scanError={false}
          onRescan={vi.fn()}
        />
      </ToastProvider>,
    );

    expect(screen.getByText(en.views.scan.integratedAlertTitle)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.integratedAlert)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.cpu.avx2)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.integrated)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.notUsedForModels)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.memory.measured)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.storage.title)).toBeInTheDocument();
  });

  it("lists integrated and discrete adapters and suppresses the integrated-only alert", () => {
    const profile = structuredClone(PRESETS.desktop_3060);
    profile.gpus.unshift(structuredClone(PRESETS.laptop16_igpu.gpus[0]));
    renderScanView(profile);

    expect(screen.getByText("Intel Iris Xe Graphics")).toBeInTheDocument();
    expect(screen.getByText("NVIDIA GeForce RTX 3060")).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.vendors.intel)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.vendors.nvidia)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.integrated)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.discrete)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.usedForModels)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.notUsedForModels)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.sharedVram)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.vram)).toBeInTheDocument();
    expect(screen.queryByText(en.views.scan.integratedAlert)).not.toBeInTheDocument();
  });

  it("does not show the built-in graphics alert when no adapter is detected", () => {
    renderScanView(PRESETS.laptop8_cpu);

    expect(screen.queryByText(en.views.scan.integratedAlert)).not.toBeInTheDocument();
  });

  it("shows success feedback after copy and saving the report", async () => {
    vi.mocked(copyHardwareReport).mockResolvedValue();
    vi.mocked(saveHardwareReport).mockResolvedValue("C:\\reports\\report.json");
    renderScanView();
    fireEvent.click(screen.getByRole("button", { name: en.views.scan.copyJson }));
    await waitFor(() =>
      expect(copyHardwareReport).toHaveBeenCalledWith(JSON.stringify(PRESETS.laptop8_cpu, null, 2)),
    );
    expect(await screen.findByText(en.views.scan.reportCopied)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.views.scan.saveFile }));
    expect(await screen.findByText(en.views.scan.reportSaved("C:\\reports\\report.json"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.views.scan.showInFolder }));
    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith("C:\\reports\\report.json"));
  });

  it("shows an error toast when saving or copying fails", async () => {
    vi.mocked(copyHardwareReport).mockRejectedValue(new Error("clipboard unavailable"));
    vi.mocked(saveHardwareReport).mockRejectedValue(new Error("disk full"));
    renderScanView();

    fireEvent.click(screen.getByRole("button", { name: en.views.scan.copyJson }));
    expect(await screen.findByText(en.views.scan.copyReportFailed("clipboard unavailable"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.views.scan.saveFile }));
    expect(await screen.findByText(en.views.scan.saveFailed("disk full"))).toBeInTheDocument();
  });

  it("shows no save toast when the dialog is cancelled", async () => {
    vi.mocked(saveHardwareReport).mockResolvedValue(null);
    renderScanView();

    fireEvent.click(screen.getByRole("button", { name: en.views.scan.saveFile }));
    await waitFor(() => expect(saveHardwareReport).toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("SettingsView and FirstRunWizard", () => {
  it("renders the real data path and supports open and copy actions", async () => {
    const dataDir = "C:\\Users\\partv\\AppData\\Local\\io.github.panthak4tech.aangan";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.mocked(getAppPaths).mockResolvedValue({ data_dir: dataDir, data_dir_exists: true });
    render(<ToastProvider><SettingsView /></ToastProvider>);

    expect(await screen.findByText(dataDir)).toBeInTheDocument();
    expect(screen.getByText(en.views.settings.privacy.title)).toBeInTheDocument();
    expect(screen.getByText(en.views.settings.language.options.hi)).toBeInTheDocument();
    expect(screen.getByText(en.views.settings.about.notices)).toBeInTheDocument();
    expect(screen.getByText(en.views.settings.data.hint)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: en.views.settings.data.openFolder }));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith(dataDir));
    fireEvent.click(screen.getByRole("button", { name: en.views.settings.data.copyPath }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(dataDir));
    expect(await screen.findByText(en.views.settings.data.copied)).toBeInTheDocument();
  });

  it("shows an explicit loading skeleton while reading the data path", () => {
    vi.mocked(getAppPaths).mockReturnValue(new Promise(() => {}));
    render(<ToastProvider><SettingsView /></ToastProvider>);
    expect(screen.getByRole("status", { name: en.views.settings.data.loading })).toBeInTheDocument();
  });

  it("shows an explicit data-path error", async () => {
    vi.mocked(getAppPaths).mockRejectedValue(new Error("path access denied"));
    render(<ToastProvider><SettingsView /></ToastProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't read the data folder: path access denied",
    );
  });

  it("completes first-run scanning and reports the selected bandwidth option", async () => {
    vi.mocked(scanHardware).mockResolvedValue(PRESETS.desktop_3060);
    const onComplete = vi.fn();
    render(<FirstRunWizard onComplete={onComplete} />);

    fireEvent.click(screen.getByRole("button", { name: en.wizard.welcome.cta }));
    expect(scanHardware).toHaveBeenCalledWith(true);
    expect(await screen.findByText(en.wizard.done.title)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.wizard.done.cta }));

    expect(onComplete).toHaveBeenCalledWith(PRESETS.desktop_3060, true);
  });

  it("shows scan errors and can copy diagnostic details", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.mocked(scanHardware).mockRejectedValue(new Error("probe failed"));
    render(<FirstRunWizard onComplete={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: en.wizard.welcome.cta }));
    expect(await screen.findByText(en.wizard.error.title)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.wizard.error.copy }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toContain('"kind": "scan_failed"');
  });
});

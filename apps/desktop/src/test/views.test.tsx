import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recommendModels, scanHardware } from "@/api/api";
import { MODELS, PRESETS } from "@/api/presets";
import { rankModels } from "@/api/estimate";
import { en } from "@/i18n/en";
import { ModelsView } from "@/app/views/ModelsView";
import { ScanView } from "@/app/views/ScanView";
import { SettingsView } from "@/app/views/SettingsView";
import { FirstRunWizard } from "@/app/wizard/FirstRunWizard";
import { TooltipProvider } from "@/components/primitives/tooltip";

vi.mock("@/api/api", () => ({
  recommendModels: vi.fn(),
  scanHardware: vi.fn(),
  APP_INFO: {
    version: "0.2.0",
    license: "MIT",
    data_dir: "C:\\Aangan",
    languages: [
      { code: "en", available: true },
      { code: "hi", available: false },
    ],
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

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

  it("allows toggling models that do not fit and shows the too-slow guidance", async () => {
    const recommendations = rankModels(PRESETS.desktop_3060, MODELS, 4096).map((item, index) =>
      index === 0
        ? { ...item, estimate: { ...item.estimate, fit: "wont_fit" as const } }
        : { ...item, estimate: { ...item.estimate, fit: "too_slow" as const } },
    );
    vi.mocked(recommendModels).mockResolvedValue(recommendations);
    render(
      <TooltipProvider>
        <ModelsView profile={PRESETS.desktop_3060} />
      </TooltipProvider>,
    );

    expect(await screen.findByText(en.views.models.nothingFits.title)).toBeInTheDocument();
    expect(screen.queryByText(recommendations[0].model.name)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(screen.getByText(recommendations[0].model.name)).toBeInTheDocument(),
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
      <ScanView profile={null} scanning={false} scanError={false} onRescan={onRescan} />,
    );
    expect(screen.getByText(en.views.scan.empty)).toBeInTheDocument();

    rerender(
      <ScanView
        profile={PRESETS.desktop_3060}
        scanning
        scanError
        onRescan={onRescan}
      />,
    );
    expect(screen.getByLabelText(en.views.scan.scanning)).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByText(en.views.scan.scanFailed)).toBeInTheDocument();
  });

  it("renders CPU, integrated GPU, memory, storage and measurement details", () => {
    render(
      <ScanView
        profile={PRESETS.laptop16_igpu}
        scanning={false}
        scanError={false}
        onRescan={vi.fn()}
      />,
    );

    expect(screen.getByText(en.views.scan.integratedAlertTitle)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.cpu.avx2)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.gpu.sharesMemory)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.memory.measured)).toBeInTheDocument();
    expect(screen.getByText(en.views.scan.storage.title)).toBeInTheDocument();
  });

  it("copies the JSON report and downloads a local file", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:hardware-report"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(
      <ScanView
        profile={PRESETS.laptop8_cpu}
        scanning={false}
        scanError={false}
        onRescan={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: en.views.scan.copyJson }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(JSON.stringify(PRESETS.laptop8_cpu, null, 2)));
    expect(await screen.findByText(en.views.scan.copied)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.views.scan.saveFile }));
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:hardware-report");
  });
});

describe("SettingsView and FirstRunWizard", () => {
  it("renders privacy, data, language and about settings", () => {
    render(<SettingsView />);

    expect(screen.getByText(en.views.settings.privacy.title)).toBeInTheDocument();
    expect(screen.getByText("C:\\Aangan")).toBeInTheDocument();
    expect(screen.getByText(en.views.settings.language.options.hi)).toBeInTheDocument();
    expect(screen.getByText(en.views.settings.about.notices)).toBeInTheDocument();
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

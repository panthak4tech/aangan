import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkRuntimeUpdates,
  getNetworkState,
  installRuntime,
  listRuntimes,
  listenNetworkState,
  listenRuntimeProgress,
  removeRuntime,
} from "@/api/api";
import type { DownloadProgress, NetworkState, RuntimeCatalog, RuntimeInstallResult } from "@/api/types";
import { en } from "@/i18n/en";
import { RuntimesView } from "@/app/views/RuntimesView";

vi.mock("@/api/api", () => ({
  checkRuntimeUpdates: vi.fn(),
  getNetworkState: vi.fn(),
  installRuntime: vi.fn(),
  listRuntimes: vi.fn(),
  listenNetworkState: vi.fn(),
  listenRuntimeProgress: vi.fn(),
  removeRuntime: vi.fn(),
  setDefaultRuntime: vi.fn(),
}));

const catalog: RuntimeCatalog = {
  generatedAt: "2026-11-18T00:00:00Z",
  signatureVerified: true,
  warning: null,
  updateStatus: null,
  defaultRuntime: null,
  runtimes: [
    {
      id: "llama.cpp",
      displayName: "llama.cpp",
      version: "b1234",
      license: "MIT",
      homepage: "https://github.com/ggml-org/llama.cpp",
      recommendedVariant: "cuda-12.4",
      recommendationReason: "Your NVIDIA driver supports this CUDA build.",
      variants: [
        {
          variant: "cpu",
          kind: "cpu",
          requiresCudaDriver: null,
          sizeBytes: 120_000_000,
        },
        {
          variant: "cuda-12.4",
          kind: "cuda",
          requiresCudaDriver: 12040,
          sizeBytes: 280_000_000,
        },
      ],
      installed: [],
    },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.mocked(listRuntimes).mockResolvedValue(catalog);
  vi.mocked(getNetworkState).mockResolvedValue({
    offlineMode: false,
    active: 0,
    hosts: [],
    purposes: [],
    bytesDown: 0,
  });
  vi.mocked(listenRuntimeProgress).mockResolvedValue(() => {});
  vi.mocked(listenNetworkState).mockResolvedValue(() => {});
  vi.mocked(installRuntime).mockResolvedValue({
    runtimeId: "llama.cpp",
    version: "b1234",
    variant: "cuda-12.4",
    path: "C:\\data\\runtimes\\llama.cpp\\b1234-cuda-12.4",
    warning: null,
  });
});

describe("RuntimesView", () => {
  it("shows the recommended variant and starts its install", async () => {
    render(<RuntimesView />);

    expect(await screen.findByText(/Recommended for your PC: CUDA 12\.4/))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.views.runtimes.install }));

    await waitFor(() => {
      expect(installRuntime).toHaveBeenCalledWith("llama.cpp", "b1234", "cuda-12.4");
    });
  });

  it("explains and disables installation while Offline mode is on", async () => {
    vi.mocked(getNetworkState).mockResolvedValue({
      offlineMode: true,
      active: 0,
      hosts: [],
      purposes: [],
      bytesDown: 0,
    });
    render(<RuntimesView />);

    expect(await screen.findByText(en.views.runtimes.offline)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.views.runtimes.install })).toBeDisabled();
  });

  it("falls back to an offered variant when a saved variant disappears", async () => {
    const updated = structuredClone(catalog);
    updated.updateStatus = "updated";
    updated.runtimes[0].recommendedVariant = "cpu";
    updated.runtimes[0].variants = [updated.runtimes[0].variants[0]];
    vi.mocked(checkRuntimeUpdates).mockResolvedValue(updated);
    render(<RuntimesView />);

    fireEvent.click(screen.getByRole("button", { name: en.views.runtimes.checkUpdates }));

    expect(await screen.findByRole("radio", { name: /CPU/ })).toBeChecked();
    expect(screen.getByRole("button", { name: en.views.runtimes.install })).toBeEnabled();
  });

  it("shows a successful no-update result as status", async () => {
    vi.mocked(checkRuntimeUpdates).mockResolvedValue({
      ...structuredClone(catalog),
      updateStatus: "unchanged",
    });
    render(<RuntimesView />);

    fireEvent.click(await screen.findByRole("button", { name: en.views.runtimes.checkUpdates }));

    expect(await screen.findByRole("status")).toHaveTextContent(en.views.runtimes.upToDate);
  });

  it("refreshes the catalog when the selected version becomes stale", async () => {
    const newerCatalog = structuredClone(catalog);
    newerCatalog.runtimes[0].version = "b1235";
    vi.mocked(listRuntimes)
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce(newerCatalog);
    vi.mocked(installRuntime).mockRejectedValueOnce(new Error("runtime_manifest_changed"));
    render(<RuntimesView />);

    fireEvent.click(await screen.findByRole("button", { name: en.views.runtimes.install }));

    expect(await screen.findByText(/Version b1235/)).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent(en.views.runtimes.catalogChanged);
  });

  it("keeps concurrent variant installs independent across navigation", async () => {
    let finishCpu: ((result: RuntimeInstallResult) => void) | undefined;
    let finishCuda: ((result: RuntimeInstallResult) => void) | undefined;
    vi.mocked(installRuntime)
      .mockImplementationOnce(() => new Promise((resolve) => { finishCuda = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishCpu = resolve; }));
    const { rerender } = render(<RuntimesView />);

    await screen.findByText("llama.cpp");
    fireEvent.click(screen.getByText(en.views.runtimes.chooseVariant));
    fireEvent.click(await screen.findByRole("radio", { name: /CUDA 12\.4/ }));
    fireEvent.click(await screen.findByRole("button", { name: en.views.runtimes.install }));
    fireEvent.click(screen.getByRole("radio", { name: /CPU/ }));
    fireEvent.click(screen.getByRole("button", { name: en.views.runtimes.install }));
    expect(installRuntime).toHaveBeenNthCalledWith(1, "llama.cpp", "b1234", "cuda-12.4");
    expect(installRuntime).toHaveBeenNthCalledWith(2, "llama.cpp", "b1234", "cpu");

    rerender(<RuntimesView active={false} />);
    rerender(<RuntimesView active />);
    finishCuda?.({
      runtimeId: "llama.cpp",
      version: "b1234",
      variant: "cuda-12.4",
      path: "C:\\data\\runtimes\\llama.cpp\\b1234-cuda-12.4",
      warning: null,
    });
    await waitFor(() => expect(finishCpu).toBeDefined());
    expect(screen.getByRole("button", { name: /Installing/ })).toBeDisabled();
    finishCpu?.({
      runtimeId: "llama.cpp",
      version: "b1234",
      variant: "cpu",
      path: "C:\\data\\runtimes\\llama.cpp\\b1234-cpu",
      warning: null,
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: en.views.runtimes.install })).toBeEnabled(),
    );
  });

  it("shows archive cleanup warnings without treating installation as failed", async () => {
    vi.mocked(installRuntime).mockResolvedValueOnce({
      runtimeId: "llama.cpp",
      version: "b1234",
      variant: "cuda-12.4",
      path: "C:\\data\\runtimes\\llama.cpp\\b1234-cuda-12.4",
      warning: "Runtime installed, but could not remove download archive(s).",
    });
    render(<RuntimesView />);

    fireEvent.click(await screen.findByRole("button", { name: en.views.runtimes.install }));
    await waitFor(() =>
      expect(installRuntime).toHaveBeenCalledWith("llama.cpp", "b1234", "cuda-12.4"),
    );

    expect(await screen.findByRole("status")).toHaveTextContent("Runtime installed");
  });

  it("preserves newer network events when the initial snapshot resolves late", async () => {
    let emitNetwork: ((state: NetworkState) => void) | undefined;
    let resolveSnapshot: ((state: NetworkState) => void) | undefined;
    vi.mocked(listenNetworkState).mockImplementation(async (onState) => {
      emitNetwork = onState;
      return () => {};
    });
    vi.mocked(getNetworkState).mockImplementation(
      () => new Promise((resolve) => { resolveSnapshot = resolve; }),
    );
    render(<RuntimesView />);

    await waitFor(() => expect(emitNetwork).toBeDefined());
    emitNetwork?.({
      offlineMode: true,
      active: 0,
      hosts: [],
      purposes: [],
      bytesDown: 0,
    });
    resolveSnapshot?.({
      offlineMode: false,
      active: 0,
      hosts: [],
      purposes: [],
      bytesDown: 0,
    });

    expect(await screen.findByText(en.views.runtimes.offline)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.views.runtimes.install })).toBeDisabled();
  });

  it("shows runtime removal errors within the open confirmation dialog", async () => {
    const withInstall = structuredClone(catalog);
    withInstall.runtimes[0].installed = [{
      runtimeId: "llama.cpp",
      version: "b1234",
      variant: "cuda-12.4",
      path: "C:\\data\\runtimes\\llama.cpp\\b1234-cuda-12.4",
      sizeBytes: 1200,
      isDefault: false,
    }];
    vi.mocked(listRuntimes).mockResolvedValue(withInstall);
    vi.mocked(removeRuntime).mockRejectedValueOnce(new Error("runtime is locked"));
    render(<RuntimesView />);

    fireEvent.click(await screen.findByRole("button", { name: en.views.runtimes.remove }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: en.views.runtimes.remove }));

    expect(await screen.findByRole("alert")).toHaveTextContent("runtime is locked");
    expect(dialog).toContainElement(screen.getByRole("alert"));
  });

  it("clears completed progress when the corresponding installed runtime is removed", async () => {
    let emitProgress: ((next: DownloadProgress) => void) | undefined;
    vi.mocked(listenRuntimeProgress).mockImplementation(async (onProgress) => {
      emitProgress = onProgress;
      return () => {};
    });
    const withInstall = structuredClone(catalog);
    withInstall.runtimes[0].installed = [{
      runtimeId: "llama.cpp",
      version: "b1234",
      variant: "cuda-12.4",
      path: "C:\\data\\runtimes\\llama.cpp\\b1234-cuda-12.4",
      sizeBytes: 1200,
      isDefault: false,
    }];
    const afterRemoval = structuredClone(catalog);
    vi.mocked(listRuntimes)
      .mockResolvedValueOnce(withInstall)
      .mockResolvedValueOnce(afterRemoval);
    render(<RuntimesView />);

    await waitFor(() => expect(emitProgress).toBeDefined());
    emitProgress?.({
      id: "runtime-llama.cpp-b1234-cuda-12.4",
      state: { kind: "done" },
      done: 100,
      total: 100,
      bytesPerSec: 0,
      etaSecs: null,
    });
    expect(await screen.findByText(en.views.runtimes.done)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: en.views.runtimes.remove }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: en.views.runtimes.remove }));

    await waitFor(() => expect(screen.queryByText(en.views.runtimes.done)).not.toBeInTheDocument());
  });
});

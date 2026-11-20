import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNetworkState,
  installRuntime,
  listRuntimes,
  listenNetworkState,
  listenRuntimeProgress,
} from "@/api/api";
import type { RuntimeCatalog } from "@/api/types";
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
  vi.clearAllMocks();
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
  });
});

describe("RuntimesView", () => {
  it("shows the recommended variant and starts its install", async () => {
    render(<RuntimesView />);

    expect(await screen.findByText(/Recommended for your PC: CUDA 12\.4/))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.views.runtimes.install }));

    await waitFor(() => {
      expect(installRuntime).toHaveBeenCalledWith("llama.cpp", "cuda-12.4");
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
});

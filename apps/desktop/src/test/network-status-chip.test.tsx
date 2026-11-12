import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNetworkActivity,
  getNetworkState,
  listenNetworkState,
  setOfflineMode,
} from "@/api/api";
import type { NetworkState } from "@/api/types";
import { NetworkStatusChip } from "@/app/NetworkStatusChip";
import { en } from "@/i18n/en";

vi.mock("@/api/api", () => ({
  getNetworkActivity: vi.fn(),
  getNetworkState: vi.fn(),
  listenNetworkState: vi.fn(),
  setOfflineMode: vi.fn(),
}));

const idleState: NetworkState = {
  offlineMode: false,
  active: 0,
  hosts: [],
  purposes: [],
  bytesDown: 0,
};

function renderChip(onShowActivity = vi.fn()) {
  return {
    onShowActivity,
    ...render(<NetworkStatusChip canViewActivity onShowActivity={onShowActivity} />),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getNetworkState).mockResolvedValue(idleState);
  vi.mocked(getNetworkActivity).mockResolvedValue([]);
  vi.mocked(listenNetworkState).mockResolvedValue(vi.fn());
  vi.mocked(setOfflineMode).mockImplementation(async (offlineMode) => ({
    ...idleState,
    offlineMode,
  }));
});

describe("NetworkStatusChip", () => {
  it("announces the idle state", async () => {
    renderChip();

    expect(await screen.findByRole("status")).toHaveTextContent(
      en.views.settings.network.chipIdle,
    );
  });

  it("announces active hosts and additional hosts", async () => {
    vi.mocked(getNetworkState).mockResolvedValue({
      ...idleState,
      active: 2,
      hosts: ["huggingface.co", "cdn-lfs.hf.co"],
      purposes: ["model_download"],
      bytesDown: 1024,
    });
    renderChip();

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Online: downloading from huggingface.co and 1 more",
    );
  });

  it("announces when Offline mode blocks network requests", async () => {
    vi.mocked(getNetworkState).mockResolvedValue({ ...idleState, offlineMode: true });
    renderChip();

    expect(await screen.findByRole("status")).toHaveTextContent(
      en.views.settings.network.chipBlocked,
    );
  });

  it("reports unavailable network state and exposes the error", async () => {
    vi.mocked(getNetworkState).mockRejectedValue(new Error("network state unavailable"));
    renderChip();

    expect(await screen.findByRole("status")).toHaveTextContent(
      en.views.settings.network.statusUnavailable,
    );
    fireEvent.click(screen.getByRole("button", { name: /Network status unavailable/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("network state unavailable");
  });

  it("shows active request details and toggles Offline mode", async () => {
    const user = userEvent.setup();
    vi.mocked(getNetworkState).mockResolvedValue({
      ...idleState,
      active: 1,
      hosts: ["raw.githubusercontent.com"],
      purposes: ["catalog"],
      bytesDown: 128,
    });
    vi.mocked(getNetworkActivity).mockResolvedValue([{
      id: 1,
      startedMs: Date.parse("2026-10-22T13:30:00Z"),
      purpose: "catalog",
      host: "raw.githubusercontent.com",
      via: null,
      bytesDown: 128,
      ok: null,
      note: "",
    }]);
    const { onShowActivity } = renderChip();

    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("button", { name: /Online: downloading/ }));
    expect(await screen.findByText("128 B downloaded so far")).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: en.views.settings.network.offlineMode }));
    await waitFor(() => expect(setOfflineMode).toHaveBeenCalledWith(true));

    await user.click(screen.getByRole("button", { name: en.views.settings.network.seeActivity }));
    expect(onShowActivity).toHaveBeenCalledOnce();
  });

  it("closes the popover with Escape and restores focus to the chip", async () => {
    const user = userEvent.setup();
    renderChip();

    const chip = await screen.findByRole("button", { name: /Offline: nothing/ });
    await user.click(chip);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(chip).toHaveFocus();
  });
});

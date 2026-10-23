import { fireEvent, render, screen } from "@testing-library/react";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AboutDialog } from "@/app/notices/NoticesDialog";
import { ToastProvider } from "@/components/ui/toast-provider";
import { en } from "@/i18n/en";
import {
  excludeWorkspacePackages,
  filterNotices,
  javascriptNotices,
  mergeNotices,
  normalizeLineEndings,
  normalizeLicenseText,
  noticeKey,
  renderMarkdown,
  sortNotices,
  type Notice,
} from "../../../../scripts/notices-data.mjs";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const notices: Notice[] = [
  {
    name: "Zeta",
    version: "1.0.0",
    license: "MIT",
    repository: "https://example.com/zeta",
    text: "Zeta license text",
  },
  {
    name: "Alpha",
    version: "2.0.0",
    license: "Apache-2.0",
    repository: "https://example.com/alpha",
    text: "Alpha license text",
  },
];

describe("notices helpers", () => {
  it("excludes the application package from third-party notices", () => {
    const aanganPackage = { name: "desktop" };
    const notices = javascriptNotices(
      {
        [`${aanganPackage.name}@0.2.0`]: { licenses: "UNLICENSED" },
        "react@19.1.0": {
          licenseFile: "react/LICENSE",
          version: "19.1.0",
          licenses: "MIT",
          repository: "https://github.com/facebook/react",
        },
      },
      aanganPackage.name,
      new Map(),
      () => "React license text",
    );

    expect(notices.map((notice) => notice.name)).toEqual(["react"]);
  });

  it("removes trailing whitespace from generated license text", () => {
    expect(normalizeLicenseText("\nLicense line  \n  continued\t\n")).toBe(
      "License line\n  continued",
    );
  });

  it("normalizes line endings when comparing generated notices", () => {
    expect(normalizeLineEndings("first\r\nsecond\rthird")).toBe("first\nsecond\nthird");
  });

  it("excludes every workspace Rust package from third-party notices", () => {
    const packages = [
      { package: { name: "aangan-cli" } },
      { package: { name: "aangan-desktop" } },
      { package: { name: "serde" } },
    ];

    expect(excludeWorkspacePackages(packages, new Set(["aangan-cli", "aangan-desktop"]))).toEqual([
      packages[2],
    ]);
  });

  it("renders only third-party notice components with the corrected intro", () => {
    expect(renderMarkdown([notices[0]])).toContain(
      "Third-party notices. Components bundled in Aangan and their licenses. Aangan itself is MIT licensed (see LICENSE).",
    );
    expect(renderMarkdown([notices[0]])).toContain("## Zeta 1.0.0");
  });

  it("chooses a Markdown fence longer than backtick runs in license text", () => {
    const license = { ...notices[0], text: "Example:\n```\ncode\n```" };

    expect(renderMarkdown([license])).toContain("````text\nExample:\n```\ncode\n```\n````");
  });

  it("sorts entries by name and filters on searchable metadata", () => {
    expect(sortNotices(notices).map((notice) => notice.name)).toEqual(["Alpha", "Zeta"]);
    expect(filterNotices(notices, "apache")).toEqual([notices[1]]);
    expect(filterNotices(notices, "missing")).toEqual([]);
    expect(filterNotices(notices, "  ")).toBe(notices);
  });

  it("merges identical entries from multiple license sources and rejects conflicts", () => {
    expect(mergeNotices([notices[0]], [notices[0]])).toEqual([notices[0]]);
    expect(() =>
      mergeNotices([notices[0]], [{ ...notices[0], license: "Apache-2.0" }]),
    ).toThrow("Conflicting license notices for Zeta 1.0.0");
  });

  it("includes repository in notice keys when package versions are shared", () => {
    expect(noticeKey(notices[0])).not.toBe(
      noticeKey({ ...notices[0], repository: "https://example.com/other-zeta" }),
    );
  });
});

describe("AboutDialog", () => {
  beforeEach(() => {
    vi.mocked(getVersion).mockResolvedValue("9.9.9");
    vi.mocked(invoke).mockResolvedValue(undefined);
  });

  function renderAboutDialog() {
    return render(
      <ToastProvider>
        <AboutDialog open onOpenChange={() => undefined} />
      </ToastProvider>,
    );
  }

  it("shows Aangan's current version and MIT license without dependency listings", async () => {
    renderAboutDialog();

    expect(await screen.findByText("Version 9.9.9")).toBeInTheDocument();
    expect(screen.getAllByText(/MIT License/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("opens third-party licenses through the Tauri command", async () => {
    renderAboutDialog();
    fireEvent.click(screen.getByRole("button", { name: en.views.settings.about.openThirdPartyLicenses }));

    expect(invoke).toHaveBeenCalledWith("open_third_party_notices");
  });

  it("shows a toast when opening third-party licenses fails", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("resource missing"));
    renderAboutDialog();
    fireEvent.click(screen.getByRole("button", { name: en.views.settings.about.openThirdPartyLicenses }));

    expect(
      await screen.findByText(
        en.views.settings.about.openThirdPartyLicensesFailed("resource missing"),
      ),
    ).toBeInTheDocument();
  });
});

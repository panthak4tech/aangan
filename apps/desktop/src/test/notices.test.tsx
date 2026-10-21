import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NoticesDialog } from "@/app/notices/NoticesDialog";
import { en } from "@/i18n/en";
import {
  filterNotices,
  javascriptNotices,
  mergeNotices,
  normalizeLicenseText,
  sortNotices,
  type Notice,
} from "../../../../scripts/notices-data.mjs";

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
});

describe("NoticesDialog", () => {
  it("filters notices and expands full license text as plain text", () => {
    render(<NoticesDialog open onOpenChange={() => undefined} />);
    const search = screen.getByRole("searchbox", { name: en.views.settings.about.noticesSearch });
    fireEvent.change(search, { target: { value: "Manrope" } });

    expect(screen.getByText("Manrope")).toBeInTheDocument();
    expect(screen.queryByText("react")).not.toBeInTheDocument();

    const licenseDetails = screen.getByText(en.views.settings.about.showLicense).closest("details");
    expect(licenseDetails).not.toBeNull();
    fireEvent.click(within(licenseDetails as HTMLElement).getByText(en.views.settings.about.showLicense));
    expect(within(licenseDetails as HTMLElement).getByText(/SIL OPEN FONT LICENSE/)).toBeInTheDocument();
    expect(licenseDetails?.querySelector("script")).not.toBeInTheDocument();
  });
});

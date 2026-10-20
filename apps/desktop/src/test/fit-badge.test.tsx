import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Fit } from "@/api/types";
import { en } from "@/i18n/en";
import { FitBadge } from "@/app/models/FitBadge";

const fitCases: [Fit, string, string, string][] = [
  ["great", "fit-great", "fit-great-fg", en.fit.great],
  ["good", "fit-good", "fit-good-fg", en.fit.good],
  ["slow", "fit-slow", "fit-slow-fg", en.fit.slow],
  ["too_slow", "fit-too-slow", "fit-too-slow-fg", en.fit.too_slow],
  ["wont_fit", "fit-wont-fit", "fit-wont-fit-fg", en.fit.wont_fit],
];

describe("FitBadge", () => {
  it.each(fitCases)("renders the %s label and semantic colors", (fit, background, foreground, label) => {
    render(<FitBadge fit={fit} />);
    const badge = screen.getByText(label);

    expect(badge).toHaveClass(`bg-${background}`, `text-${foreground}`);
  });
});

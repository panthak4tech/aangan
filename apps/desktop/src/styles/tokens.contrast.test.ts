/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const tokens = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");

const tokenValues = new Map(
  Array.from(tokens.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g), ([, name, value]) => [name, value]),
);

function tokenValue(name: string): string {
  const value = tokenValues.get(name);
  if (!value) throw new Error(`Missing color token --${name}`);
  return value;
}

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const contrastPairs: [string, string][] = [
  ["color-text", "color-bg"],
  ["color-text-muted", "color-bg"],
  ["color-primary-fg", "color-primary"],
  ["color-primary-fg", "color-primary-hover"],
  ["color-primary-soft-fg", "color-primary-soft"],
  ["color-accent-fg", "color-accent"],
  ["color-accent-soft-fg", "color-accent-soft"],
  ["fit-great-fg", "fit-great-bg"],
  ["fit-good-fg", "fit-good-bg"],
  ["fit-slow-fg", "fit-slow-bg"],
  ["fit-tooslow-fg", "fit-tooslow-bg"],
  ["fit-wont-fg", "fit-wont-bg"],
  ["color-text", "color-bg-subtle"],
];

describe("semantic token contrast", () => {
  it.each(contrastPairs)("--%s on --%s meets WCAG AA", (foreground, background) => {
    expect(contrastRatio(tokenValue(foreground), tokenValue(background))).toBeGreaterThanOrEqual(4.5);
  });
});

/// <reference types="node" />

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "tokens.css"), "utf8");

function parseBlock(source: string, selector: RegExp): Record<string, string> {
  const match = selector.exec(source);
  if (!match) throw new Error(`Block not found: ${selector}`);
  const tokens: Record<string, string> = {};
  for (const token of match[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[token[1]] = token[2].trim();
  }
  return tokens;
}

const themes: Record<string, Record<string, string>> = {
  light: parseBlock(css, /:root\s*\{([^}]*)\}/),
  dark: parseBlock(css, /:root\[data-theme="dark"\]\s*\{([^}]*)\}/),
};

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((value >> 16) & 255) +
    0.7152 * channel((value >> 8) & 255) +
    0.0722 * channel(value & 255)
  );
}

function contrast(first: string, second: string): number {
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

const pairs: [string, string][] = [
  ["color-text", "color-bg"],
  ["color-text-muted", "color-bg"],
  ["color-text", "color-bg-subtle"],
  ["color-text-muted", "color-bg-subtle"],
  ["color-text", "color-surface"],
  ["color-text-muted", "color-surface"],
  ["color-text", "color-surface-muted"],
  ["color-text-muted", "color-surface-muted"],
  ["color-primary-fg", "color-primary"],
  ["color-primary-fg", "color-primary-hover"],
  ["color-primary", "color-bg"],
  ["color-primary", "color-surface"],
  ["color-primary-soft-fg", "color-primary-soft"],
  ["color-accent-fg", "color-accent"],
  ["color-accent-soft-fg", "color-accent-soft"],
  ["fit-great-fg", "fit-great-bg"],
  ["fit-good-fg", "fit-good-bg"],
  ["fit-slow-fg", "fit-slow-bg"],
  ["fit-tooslow-fg", "fit-tooslow-bg"],
  ["fit-wont-fg", "fit-wont-bg"],
  ["color-danger", "color-bg"],
  ["color-danger", "color-danger-soft"],
  ["color-danger-fg", "color-danger"],
];

function hex(tokens: Record<string, string>, name: string): string {
  const value = tokens[name];
  if (!value || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`--${name} is missing or not a 6-digit hex`);
  }
  return value;
}

describe.each(Object.keys(themes))("%s theme contrast (WCAG AA)", (theme) => {
  it.each(pairs)("--%s on --%s >= 4.5:1", (foreground, background) => {
    const tokens = themes[theme];
    expect(contrast(hex(tokens, foreground), hex(tokens, background))).toBeGreaterThanOrEqual(
      4.5,
    );
  });
});

describe("theme parity", () => {
  it("dark defines every token the light theme defines", () => {
    const missing = Object.keys(themes.light).filter((name) => !(name in themes.dark));
    expect(missing).toEqual([]);
  });
});

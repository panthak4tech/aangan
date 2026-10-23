import { describe, expect, it } from "vitest";

const hardCodedColor = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl)a?\s*\(/i;
const tailwindPalette = /\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|grey|zinc|neutral|stone|black|white)(?:-\d{2,3})?\b/i;
const explicitBlackOrWhite = /\b(?:bg|text|border|ring|fill|stroke)-(?:white|black)\b/i;

const sourceFiles = import.meta.glob<string>("/src/**/*.{ts,tsx,css}", {
  eager: true,
  query: "?raw",
  import: "default",
});

describe("semantic color usage", () => {
  it("keeps hard-coded colors out of components and styles", () => {
    const files = Object.entries(sourceFiles).filter(([file]) => {
      const relativePath = file.replace(/\\/g, "/").replace(/^\/?src\//, "");
      return (
        relativePath !== "styles/tokens.css" &&
        !relativePath.startsWith("assets/") &&
        !relativePath.startsWith("test/") &&
        !relativePath.includes(".test.")
      );
    });

    for (const [file, content] of files) {
      const relativePath = file.replace(/\\/g, "/").replace(/^\/?src\//, "");
      expect(content, relativePath).not.toMatch(hardCodedColor);
      expect(content, relativePath).not.toMatch(tailwindPalette);
      expect(content, relativePath).not.toMatch(explicitBlackOrWhite);
    }
  });
});

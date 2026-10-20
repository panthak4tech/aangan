import { describe, expect, it } from "vitest";

describe("test environment", () => {
  it("provides a browser DOM", () => {
    expect(document.createElement("div")).toBeInstanceOf(HTMLElement);
  });
});

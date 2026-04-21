import { describe, expect, it } from "vitest";

import { hasMinimumSelectionSize } from "./BrowserWebviewSurface";

describe("hasMinimumSelectionSize", () => {
  it("keeps area captures at the default 24px minimum", () => {
    expect(hasMinimumSelectionSize({ x: 0, y: 0, width: 80, height: 23 })).toBe(false);
    expect(hasMinimumSelectionSize({ x: 0, y: 0, width: 24, height: 24 })).toBe(true);
  });

  it("allows smaller element-comment targets with the element minimum", () => {
    expect(hasMinimumSelectionSize({ x: 0, y: 0, width: 120, height: 18 }, 8)).toBe(true);
    expect(hasMinimumSelectionSize({ x: 0, y: 0, width: 7, height: 18 }, 8)).toBe(false);
  });
});

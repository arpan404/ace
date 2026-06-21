import { describe, expect, it } from "vitest";

import {
  clampRightSidePanelWidth,
  resolveBrowserOpenRightSidePanelWidth,
} from "./rightSidePanelWidth";

describe("right side panel width", () => {
  it("clamps panel width while preserving chat room", () => {
    expect(clampRightSidePanelWidth(300, 1600)).toBe(416);
    expect(clampRightSidePanelWidth(1200, 1000)).toBe(580);
  });

  it("opens the browser panel wider than the generic side panel", () => {
    expect(
      resolveBrowserOpenRightSidePanelWidth({
        currentWidth: 512,
        viewportWidth: 1600,
      }),
    ).toBe(896);
  });

  it("preserves a wider user-sized browser panel", () => {
    expect(
      resolveBrowserOpenRightSidePanelWidth({
        currentWidth: 1000,
        viewportWidth: 1600,
      }),
    ).toBe(1000);
  });

  it("falls back to the maximum available width on compact windows", () => {
    expect(
      resolveBrowserOpenRightSidePanelWidth({
        currentWidth: 512,
        viewportWidth: 1000,
      }),
    ).toBe(580);
  });
});

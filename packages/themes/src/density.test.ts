import { describe, expect, it } from "vitest";
import { densityIds, inboxRowHeight, phoneDensities, phoneTouchTarget } from "./density.ts";

// The phone's inbox lines at the smallest Dynamic Type size: a 17pt title on 22, a 15pt line on 20,
// scaled by xSmall's ratio (about 0.82).
const smallest = { title: 22 * 0.82, line: 20 * 0.82 };

describe("phone density", () => {
  it("keeps every settings row and inbox row a touch target in both densities", () => {
    for (const id of densityIds) {
      const density = phoneDensities[id];
      expect(density.settingsRowHeight).toBeGreaterThanOrEqual(phoneTouchTarget);
      expect(inboxRowHeight(density, smallest.title, smallest.line)).toBeGreaterThanOrEqual(
        phoneTouchTarget,
      );
    }
  });

  it("makes compact tighter than comfortable everywhere it applies", () => {
    const { comfortable, compact } = phoneDensities;
    expect(compact.settingsRowHeight).toBeLessThan(comfortable.settingsRowHeight);
    expect(compact.inboxRowPadding).toBeLessThan(comfortable.inboxRowPadding);
    expect(compact.transcriptRoom).toBeLessThan(comfortable.transcriptRoom);
  });
});

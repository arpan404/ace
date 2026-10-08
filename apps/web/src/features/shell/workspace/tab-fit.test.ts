import { expect, test } from "vitest";
import { fitTabs } from "./tab-fit.ts";

test("five crowded tabs keep readable labels and scroll rather than folding to icons", () => {
  const tabs = ["Changes", "Agents", "Files", "Browser", "Terminal"].map((key) => ({
    key,
    natural: 110,
  }));
  const fit = fitTabs(tabs, "Browser", 350);
  expect(fit.icons.size).toBe(0);
  expect([...fit.widths.values()].reduce((sum, width) => sum + width, 0)).toBeGreaterThan(350);
  expect(fit.clipped.size).toBe(0);
});

test("a truly narrow strip keeps the active label and exposes other tabs through icon tooltips", () => {
  const fit = fitTabs(
    [
      { key: "changes", natural: 150 },
      { key: "terminal", natural: 180 },
    ],
    "terminal",
    120,
  );
  expect([...fit.icons]).toEqual(["changes"]);
  expect(fit.clipped.has("terminal")).toBe(false);
});

import { expect, test } from "vitest";
import { fitTabs } from "./tab-fit.ts";

const tabs = (...naturals: number[]) =>
  naturals.map((natural, index) => ({ key: `t${index}`, natural }));
const widths = (fit: ReturnType<typeof fitTabs>) => [...fit.widths.values()];

test("tabs that fit keep their whole titles, up to 220px", () => {
  const fit = fitTabs(tabs(120, 90, 300), "t0", 800);
  expect(widths(fit)).toEqual([120, 90, 220]);
  expect(fit.icons.size).toBe(0);
});

test("when the strip is short, the other tabs narrow evenly while the showing one keeps its title", () => {
  // 400px: 2 gaps of 2px, the showing tab's 180, then 216 shared by two tabs.
  const fit = fitTabs(tabs(150, 160, 180), "t2", 400);
  expect(widths(fit)).toEqual([108, 108, 180]);
});

test("the furthest tabs fold to their icon before the showing tab gives up any of its title", () => {
  // Five tabs in 440px: sharing evenly would leave the others under 72px.
  const fit = fitTabs(tabs(140, 140, 140, 140, 200), "t4", 440);
  expect(fit.widths.get("t4")).toBe(200);
  expect(fit.icons.has("t0")).toBe(true);
  expect(fit.icons.has("t3")).toBe(false);
  expect(fit.widths.get("t0")).toBe(36);
  const total = widths(fit).reduce((sum, width) => sum + width, 0) + 2 * 4;
  expect(total).toBeLessThanOrEqual(440);
  for (const [key, width] of fit.widths)
    if (!fit.icons.has(key)) expect(width).toBeGreaterThanOrEqual(72);
});

test("with no room even for icons, the showing tab still keeps its title and the strip scrolls", () => {
  const fit = fitTabs(tabs(140, 140, 140, 190), "t3", 220);
  expect(fit.widths.get("t3")).toBe(190);
  expect([...fit.icons].toSorted()).toEqual(["t0", "t1", "t2"]);
});

test("a tab whose badge would leave its title no room folds to its icon instead", () => {
  // Changes with a +21 −9 badge needs 110px to show any of its title; 90px would show none.
  const fit = fitTabs([{ key: "changes", natural: 150, least: 110 }, ...tabs(90, 160)], "t1", 350);
  expect(fit.icons.has("changes")).toBe(true);
  expect(fit.widths.get("t0")).toBe(90);
});

test("widths are whole pixels", () => {
  const fit = fitTabs(tabs(150.4, 160.2, 170.7), "t0", 333);
  for (const width of fit.widths.values()) expect(Number.isInteger(width)).toBe(true);
});

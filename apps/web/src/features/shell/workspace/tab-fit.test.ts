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

// The pinned tools as the strip measures them: Changes with a +21 −9 badge, and Agents.
const changes = { key: "changes", natural: 150, least: 110, tool: true };
const agents = { key: "agents", natural: 100, tool: true };

test("in a 400px strip, three tabs first narrow evenly to readable titles", () => {
  const fit = fitTabs(
    [{ key: "changes", natural: 120, tool: true }, { ...agents, natural: 110 }, ...tabs(180)],
    "t0",
    400,
  );
  // 396px less the showing tab's 180: 108 each.
  expect(widths(fit)).toEqual([108, 108, 180]);
  expect(fit.icons.size).toBe(0);
});

test("in a 400px strip, the pinned tools fold one at a time, Agents before Changes", () => {
  const fit = fitTabs([changes, agents, ...tabs(260)], "t0", 400);
  expect([...fit.icons]).toEqual(["agents"]);
  // 396px less the showing tab's 220 and Agents' icon: 140 for Changes, a readable title.
  expect(widths(fit)).toEqual([140, 36, 220]);

  const tighter = fitTabs([changes, agents, ...tabs(260)], "t0", 330);
  expect([...tighter.icons].toSorted()).toEqual(["agents", "changes"]);
});

test("short of room, Changes' diff stat gives way to its dot before any tab folds", () => {
  // Changes with a +17 −5 badge (50px of it), Agents, and the showing agent tab in 390px.
  const badged = { ...changes, badge: 50 };
  const fit = fitTabs([badged, agents, { key: "agent", natural: 150 }], "agent", 390);
  expect(fit.icons.size).toBe(0);
  expect([...fit.dots]).toEqual(["changes"]);
  expect(widths(fit)).toEqual([100, 100, 150]);
  // Every tab shows its whole title, and less than 40px of the strip goes unused.
  expect(fit.clipped.size).toBe(0);
  const used = widths(fit).reduce((sum, width) => sum + width, 0) + 2 * 2;
  expect(390 - used).toBeLessThan(40);

  // With room to spare the badge stays.
  expect(fitTabs([badged, agents, { key: "agent", natural: 150 }], "agent", 600).dots.size).toBe(0);
});

test("a tab drawn narrower than its title is marked clipped, so its tooltip carries the title", () => {
  const fit = fitTabs(tabs(150, 160, 180), "t2", 400);
  expect([...fit.clipped].toSorted()).toEqual(["t0", "t1"]);
  expect(fitTabs(tabs(400), "t0", 800).clipped.has("t0")).toBe(true);
});

test("in a 400px strip of four, the tools fold before another tab loses any of its title", () => {
  // Sharing evenly would leave 71px each; folding Changes alone would leave Agents and Devices
  // titled beside a bare Changes icon.
  const fit = fitTabs(
    [changes, agents, { key: "devices", natural: 110 }, { key: "browser", natural: 180 }],
    "browser",
    400,
  );
  expect([...fit.icons].toSorted()).toEqual(["agents", "changes"]);
  expect(widths(fit)).toEqual([36, 36, 110, 180]);
});

test("in a 400px strip of four, a tab that still doesn't fit after the tools narrows, then folds", () => {
  const fit = fitTabs(
    [changes, agents, { key: "files", natural: 160 }, { key: "browser", natural: 300 }],
    "browser",
    400,
  );
  expect([...fit.icons].toSorted()).toEqual(["agents", "changes"]);
  // 394px less 220 for the showing tab and two icons: 102 for Files, still a readable title.
  expect(widths(fit)).toEqual([36, 36, 102, 220]);

  const tighter = fitTabs(
    [changes, agents, { key: "files", natural: 160 }, { key: "browser", natural: 300 }],
    "browser",
    320,
  );
  expect([...tighter.icons].toSorted()).toEqual(["agents", "changes", "files"]);
});

test("widths are whole pixels", () => {
  const fit = fitTabs(tabs(150.4, 160.2, 170.7), "t0", 333);
  for (const width of fit.widths.values()) expect(Number.isInteger(width)).toBe(true);
});

test("a selected tool tab folds to an icon when its full title cannot fit", () => {
  const fit = fitTabs(
    [{ ...changes, least: 150 }, agents, { key: "browser", natural: 180 }],
    "changes",
    100,
  );
  expect(fit.icons.has("changes")).toBe(true);
  expect(fit.widths.get("changes")).toBe(36);
});

import { expect, test } from "vitest";
import { deltaE, parseOpaqueColor } from "./colour.ts";
import { themeIds, themes } from "./palettes.ts";
import { rowFillDistance, sidebarPanel, visibleFill } from "./row-fills.ts";

const rgb = (hex: string) => {
  const parsed = parseOpaqueColor(hex);
  if (!parsed) throw new Error(`not a colour: ${hex}`);
  return parsed;
};

test("in every theme and scheme, hover and the open row show on the panel the rows sit on", () => {
  for (const id of themeIds)
    for (const scheme of ["light", "dark"] as const) {
      const palette = themes[id][scheme];
      const panel = rgb(sidebarPanel(palette.s0, palette.sidebar));
      const hover = deltaE(rgb(palette.hover), panel);
      const active = deltaE(rgb(palette.active), panel);
      expect([
        id,
        scheme,
        hover >= rowFillDistance.hover,
        active >= rowFillDistance.active,
      ]).toEqual([id, scheme, true, true]);
      // The open row stands apart from a hovered one too.
      expect([id, scheme, active > hover]).toEqual([id, scheme, true]);
    }
});

test("a fill that already shows keeps its designed value; a faint one steps toward the text", () => {
  const panel = "#FBF5EC";
  expect(visibleFill("#E0D8CC", panel, "#24211B", 5.5)).toBe("#E0D8CC");
  const stepped = visibleFill("#F8F2E9", panel, "#24211B", 5.5);
  expect(deltaE(rgb(stepped), rgb(panel))).toBeGreaterThanOrEqual(5.5);
  // Just far enough: no darker than it has to be.
  expect(deltaE(rgb(stepped), rgb(panel))).toBeLessThan(6.5);
});

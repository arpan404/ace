import { describe, expect, it } from "vitest";
import {
  cellsUnder,
  contrastProblems,
  gradientStops,
  parseComputedColour,
  worstContrast,
  type ColourSample,
  type PaintLayer,
  type Rgba,
} from "./colour-check.ts";

const white: Rgba = [255, 255, 255, 1];
const black: Rgba = [0, 0, 0, 1];
const clear: Rgba = [0, 0, 0, 0];
const layer = (color: Rgba, opacity = 1, stops: Rgba[] = []): PaintLayer => ({
  color,
  stops,
  opacity,
});
const sample = (overrides: Partial<ColourSample>): ColourSample => ({
  part: "thread-title",
  kind: "text",
  fg: black,
  layers: [layer(white)],
  backdrop: [[255, 255, 255]],
  fontSize: 13,
  fontWeight: 400,
  ...overrides,
});

describe("computed colours", () => {
  it.each([
    ["rgb(10, 20, 30)", [10, 20, 30, 1]],
    ["rgba(10, 20, 30, 0.5)", [10, 20, 30, 0.5]],
    ["rgb(10 20 30 / 25%)", [10, 20, 30, 0.25]],
    ["transparent", [0, 0, 0, 0]],
    ["color(srgb 1 0 0.5 / 0.4)", [255, 0, 127.5, 0.4]],
    ["oklch(0.7 0.1 200)", undefined],
    ["rgb(10, 20)", undefined],
  ])("%s reads as %j", (text, expected) => {
    expect(parseComputedColour(text)).toEqual(expected);
  });

  it("finds every stop of a computed gradient, and none in a plain image", () => {
    expect(gradientStops("linear-gradient(rgb(255, 0, 0) 0%, rgba(0, 0, 255, 0.5) 100%)")).toEqual([
      "rgb(255, 0, 0)",
      "rgba(0, 0, 255, 0.5)",
    ]);
    expect(gradientStops("none")).toEqual([]);
  });
});

describe("contrast as rendered", () => {
  it.each<[string, Partial<ColourSample>, number, number]>([
    ["black on white", {}, 20.9, 21.1],
    ["grey text at half alpha on white", { fg: [0, 0, 0, 0.5] }, 3.9, 4.1],
    // A see-through panel shows the scene under it: dark text over a dark scene fails.
    [
      "a 20% white panel over a dark scene",
      { layers: [layer([255, 255, 255, 0.2])], backdrop: [[10, 10, 10]] },
      1.8,
      1.95,
    ],
    // A container's opacity fades its text and background together into what lies below.
    [
      "white text on black inside a container at 30% over white",
      { fg: white, layers: [layer(clear, 0.3), layer(black)] },
      2.0,
      2.2,
    ],
  ])("%s", (_name, overrides, low, high) => {
    const measured = worstContrast(sample(overrides));
    expect(measured?.ratio).toBeGreaterThan(low);
    expect(measured?.ratio).toBeLessThan(high);
  });

  it("text over a gradient is judged against its worst stop", () => {
    const measured = worstContrast(
      sample({ fg: white, layers: [layer(black, 1, [black, [200, 200, 200, 1]])] }),
    );
    expect(measured?.bg.map(Math.round)).toEqual([200, 200, 200]);
  });

  it("text over a scene is judged against its brightest cell", () => {
    const measured = worstContrast(
      sample({
        fg: white,
        layers: [layer(clear)],
        backdrop: [
          [0, 0, 0],
          [250, 250, 250],
        ],
      }),
    );
    expect(measured?.ratio).toBeLessThan(1.1);
  });
});

describe("live-contrast problems", () => {
  it.each<[string, Partial<ColourSample>, number]>([
    ["grey #777 small text on white fails 4.5:1", { fg: [119, 119, 119, 1] }, 1],
    ["the same grey as 24 px text passes 3:1", { fg: [119, 119, 119, 1], fontSize: 24 }, 0],
    [
      "the same grey bold at 19 px passes",
      { fg: [119, 119, 119, 1], fontSize: 19, fontWeight: 700 },
      0,
    ],
    ["a #999 icon fails 3:1", { kind: "mark", fg: [153, 153, 153, 1] }, 1],
    ["a #777 icon passes 3:1", { kind: "mark", fg: [119, 119, 119, 1] }, 0],
  ])("%s", (_name, overrides, count) => {
    expect(contrastProblems([sample(overrides)], "light")).toHaveLength(count);
  });

  it("names the part once with its worst place and how many places fail", () => {
    const problems = contrastProblems(
      [
        sample({ fg: [150, 150, 150, 1] }),
        sample({ fg: [200, 200, 200, 1] }),
        sample({ part: "message-agent" }),
      ],
      "dark",
    );
    expect(problems).toEqual([
      {
        scheme: "dark",
        check: "live-contrast",
        field: "thread-title",
        message: expect.stringMatching(/#c8c8c8 on #ffffff, 1\.\d\d:1 .*needs 4\.5:1 \(2 places/),
      },
    ]);
  });
});

describe("scene cells under a box", () => {
  // A 2×2 grid over a 100×100 scene: red, green / blue, transparent.
  const grid = {
    columns: 2,
    rows: 2,
    pixels: [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0],
    box: { left: 0, top: 0, width: 100, height: 100 },
  };
  it.each<[string, { left: number; top: number; width: number; height: number }, number[][]]>([
    ["the top-left cell alone", { left: 10, top: 10, width: 20, height: 20 }, [[255, 0, 0]]],
    [
      "a box across the top row",
      { left: 10, top: 10, width: 80, height: 20 },
      [
        [255, 0, 0],
        [0, 255, 0],
      ],
    ],
    [
      "a transparent cell shows the base",
      { left: 60, top: 60, width: 20, height: 20 },
      [[9, 9, 9]],
    ],
    ["outside the scene", { left: 200, top: 200, width: 10, height: 10 }, []],
  ])("%s", (_name, box, expected) => {
    expect(cellsUnder(grid, box, [9, 9, 9])).toEqual(expected);
  });
});

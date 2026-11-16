import { sceneGlassRectsMax } from "@ace/protocol/suits";
import { expect, test } from "vitest";
import { glassFilter, sceneGlass, type GlassPane } from "./scene-glass.ts";

const frame = { left: 0, top: 0, width: 1440, height: 900 };
const pane = (over: Partial<GlassPane> = {}): GlassPane => ({
  left: 10,
  top: 20,
  width: 300,
  height: 800,
  radius: 12,
  blur: 24,
  saturate: 1.8,
  ...over,
});

test("panes become rectangles in the scene frame's own pixels", () => {
  expect(sceneGlass([pane()], { ...frame, left: 100, top: 40 })).toEqual([
    { x: -90, y: -20, width: 300, height: 800, radius: 12, blur: 24, saturate: 1.8 },
  ]);
});

test("a corner is never rounder than the pane, and a pill's radius is half its height", () => {
  const [pill] = sceneGlass([pane({ height: 30, radius: 9999 })], frame);
  expect(pill?.radius).toBe(15);
});

test("empty panes and panes wholly outside the frame send nothing", () => {
  expect(
    sceneGlass(
      [pane({ width: 0 }), pane({ left: 1500 }), pane({ top: -900, height: 800 }), pane()],
      frame,
    ),
  ).toHaveLength(1);
});

test("a layout that moved by less than half a pixel sends the same rectangles", () => {
  expect(sceneGlass([pane({ left: 10.1, width: 299.9 })], frame)).toEqual(
    sceneGlass([pane()], frame),
  );
});

test("past the protocol's limit, the largest panes are kept, in page order", () => {
  const small = Array.from({ length: sceneGlassRectsMax }, (_, i) =>
    pane({ left: i, width: 10, height: 10 }),
  );
  const big = pane({ left: 500, width: 600, height: 600 });
  const rects = sceneGlass([...small, big], frame);
  expect(rects).toHaveLength(sceneGlassRectsMax);
  expect(rects.at(-1)).toMatchObject({ x: 500, width: 600 });
  expect(rects.map((rect) => rect.x)).not.toContain(sceneGlassRectsMax - 1);
});

test("blur and saturation are read from a computed backdrop filter, in either unit", () => {
  expect(glassFilter("blur(24px) saturate(1.8) contrast(1.1)")).toEqual({
    blur: 24,
    saturate: 1.8,
  });
  expect(glassFilter("saturate(180%)")).toEqual({ saturate: 1.8 });
  expect(glassFilter("none")).toEqual({});
});

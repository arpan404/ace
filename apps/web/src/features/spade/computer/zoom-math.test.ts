import { expect, test } from "vitest";
import { clampZoom, fitView, panBy, zoomAt } from "./zoom-math.ts";

const frame = { width: 1000, height: 600 };

test("zooming keeps the point under the pointer where it was", () => {
  const view = zoomAt(fitView, 2, { x: 800, y: 300 }, frame);
  expect((800 - view.x) / view.scale).toBeCloseTo(800, 5);
});

test("zoom stays between Fit and eight times, and Fit resets the pan", () => {
  expect(clampZoom(0.2)).toBe(1);
  expect(clampZoom(50)).toBe(8);
  expect(zoomAt({ scale: 3, x: -300, y: -100 }, 1, { x: 0, y: 0 }, frame)).toEqual(fitView);
});

test("panning never shows a gap past the picture's edges", () => {
  const zoomed = { scale: 2, x: 0, y: 0 };
  expect(panBy(zoomed, { x: 500, y: 500 }, frame)).toEqual(zoomed);
  expect(panBy(zoomed, { x: -5000, y: -5000 }, frame)).toEqual({ scale: 2, x: -1000, y: -600 });
});

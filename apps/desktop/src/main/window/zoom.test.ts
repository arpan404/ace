import { expect, test } from "vitest";
import { applyZoom } from "./zoom.ts";

function page(level = 0) {
  let current = level;
  return {
    getZoomLevel: () => current,
    setZoomLevel: (next: number) => {
      current = next;
    },
    isDestroyed: () => false,
    level: () => current,
  };
}

test("zoom steps half a level each way and Actual Size returns to 100%", () => {
  const app = page();
  applyZoom(app, "in");
  applyZoom(app, "in");
  expect(app.level()).toBe(1);
  applyZoom(app, "out");
  expect(app.level()).toBe(0.5);
  applyZoom(app, "reset");
  expect(app.level()).toBe(0);
});

test("zoom stops at Chromium's 25% and 500% instead of stepping past them", () => {
  const big = page(8.5);
  applyZoom(big, "in");
  expect(big.level()).toBe(8.5);
  const small = page(-7.5);
  applyZoom(small, "out");
  expect(small.level()).toBe(-7.5);
});

test("a closed window's page is left alone", () => {
  const closed = {
    ...page(),
    isDestroyed: () => true,
    setZoomLevel: () => {
      throw new Error("zoomed a destroyed page");
    },
  };
  expect(() => applyZoom(closed, "in")).not.toThrow();
  expect(() => applyZoom(undefined, "in")).not.toThrow();
});

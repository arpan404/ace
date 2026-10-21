import { expect, test } from "vitest";
import {
  draggedSize,
  drawnScale,
  emulationFor,
  presetById,
  presetSize,
  rotated,
  sizeForEmulation,
} from "./devices.ts";
import { pageKey } from "./page-keys.ts";
import { zoomForKey, zoomIn, zoomOut } from "@ace/ui-core";

const press = (key: string, code: string, extra: Partial<Parameters<typeof pageKey>[0]> = {}) =>
  pageKey({ key, code, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...extra });

test("a phone keeps its pixel ratio, touch and user agent on its side", () => {
  const phone = presetById("iphone-16-pro");
  if (!phone) throw new Error("preset missing");
  const emulation = emulationFor(rotated(presetSize(phone)), 2);
  expect(emulation).toMatchObject({
    width: 874,
    height: 402,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
  });
  expect(emulation.userAgent).toContain("iPhone");
  // The same device turned back is recognised as that phone, either way up.
  expect(sizeForEmulation(emulation).preset).toBe("iphone-16-pro");
  expect(
    sizeForEmulation({ width: 333, height: 444, mobile: false, deviceScaleFactor: 1 }),
  ).toEqual({ preset: "responsive", width: 333, height: 444 });
});

test("dragging a handle resizes the centred frame by the drag at its drawn scale, within limits", () => {
  const start = { width: 400, height: 600 };
  // The frame is centred, so its right edge moves half as far as its width grows.
  expect(draggedSize(start, "right", { dx: 50, dy: 80 }, 0.5)).toEqual({ width: 600, height: 600 });
  expect(draggedSize(start, "bottom", { dx: 50, dy: 80 }, 0.5)).toEqual({
    width: 400,
    height: 760,
  });
  expect(draggedSize(start, "corner", { dx: -1000, dy: 0 }, 1)).toEqual({
    width: 100,
    height: 600,
  });
  // Fit never draws a device larger than the room there is, nor beyond 100%.
  expect(drawnScale("fit", { width: 1920, height: 1080 }, { width: 1008, height: 600 })).toBe(0.5);
  expect(drawnScale("fit", { width: 300, height: 300 }, { width: 2000, height: 2000 })).toBe(1);
  expect(drawnScale(1.5, { width: 300, height: 300 }, { width: 2000, height: 2000 })).toBe(1.5);
});

test("zoom keys step through a browser's levels and ⌘0 goes back to 100%", () => {
  expect(zoomIn(1)).toBe(1.1);
  expect(zoomOut(1)).toBe(0.9);
  expect(zoomIn(1.05)).toBe(1.1);
  expect(zoomIn(5)).toBe(5);
  expect(zoomOut(0.25)).toBe(0.25);
  expect(zoomForKey("0", 2)).toBe(1);
  expect(press("+", "Equal", { shiftKey: true })).toBe("zoomIn");
  expect(press("=", "Equal")).toBe("zoomIn");
  expect(press("-", "Minus")).toBe("zoomOut");
  expect(press("i", "KeyI", { altKey: true })).toBe("devtools");
  expect(press("u", "KeyU", { altKey: true })).toBe("source");
  expect(press("p", "KeyP")).toBe("print");
  // Keys without ⌘ or Ctrl go to the page.
  expect(
    pageKey({
      key: "p",
      code: "KeyP",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    }),
  ).toBeUndefined();
});

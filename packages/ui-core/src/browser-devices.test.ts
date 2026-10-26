import { expect, test } from "vitest";
import {
  deviceLabel,
  draggedSize,
  drawnScale,
  emulationFor,
  openingDevice,
  phonePresetFor,
  presetById,
  presetSize,
  rotated,
  sizeForEmulation,
} from "./browser-devices.ts";

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

test("a phone opens at the iPhone nearest its width, unless the tab already has a device", () => {
  expect(phonePresetFor(390).id).toBe("iphone-16-pro");
  expect(phonePresetFor(375).id).toBe("iphone-se");
  expect(phonePresetFor(430).id).toBe("iphone-16-pro-max");
  const own = presetSize(phonePresetFor(402));
  expect(openingDevice(undefined, own)).toEqual({ size: own, send: true });
  // A device chosen elsewhere, by an agent or on another screen, is kept and shown.
  const pixel = { width: 412, height: 923, deviceScaleFactor: 2.625, mobile: true, touch: true };
  const agents = openingDevice({ ...pixel, by: "agent" }, own);
  expect(agents.send).toBe(false);
  expect(deviceLabel(agents.size)).toBe("Pixel 9");
  const desktop = openingDevice(
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false, touch: false, by: "human" },
    own,
  );
  expect(desktop).toEqual({ size: { preset: "laptop", width: 1280, height: 800 }, send: false });
  expect(deviceLabel({ preset: "responsive", width: 500, height: 500 })).toBe("Responsive");
});

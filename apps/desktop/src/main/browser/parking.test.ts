import { expect, it } from "vitest";
import { parkingOrigin, parkingWindowOptions } from "./parking.ts";

it("parks agent views offscreen where the compositor still renders them", () => {
  const options = parkingWindowOptions({ width: 1280, height: 720 });
  // Offscreen: the person never sees the parking window, but a hidden window would give
  // Chromium no frames, stalling requestAnimationFrame while an agent drives the view.
  expect(options.x).toBeLessThanOrEqual(-1_000);
  expect(options.y).toBeLessThanOrEqual(-1_000);
  expect({ x: options.x, y: options.y }).toEqual(parkingOrigin);
});

it("a parking window keeps the requested size so a parked view holds real bounds", () => {
  expect(parkingWindowOptions({ width: 1024, height: 768 })).toMatchObject({
    width: 1024,
    height: 768,
  });
});

it("parking never takes focus or a taskbar slot", () => {
  // Created hidden and shown inactive offscreen by the host: no focus steal, no Dock/taskbar entry.
  expect(parkingWindowOptions({ width: 800, height: 600 })).toMatchObject({
    show: false,
    focusable: false,
    skipTaskbar: true,
  });
});

it("parking stays invisible where the OS pulls it back on screen", () => {
  // macOS keeps a shown window on a display, so the parked page must not be seen or clicked.
  expect(parkingWindowOptions({ width: 800, height: 600 })).toMatchObject({
    frame: false,
    opacity: 0,
    hasShadow: false,
    hiddenInMissionControl: true,
  });
});

it("parking never opens its own full-screen Space beside a full-screen app window", () => {
  // macOS opens a new full-screen-capable window as a full-screen Space while the app is full screen.
  expect(parkingWindowOptions({ width: 800, height: 600 })).toMatchObject({
    fullscreenable: false,
  });
});

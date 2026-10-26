import { describe, expect, it } from "vitest";
import { parkingOrigin, parkingWindow } from "./parking.ts";

const size = { width: 1280, height: 720 };

describe.each(["darwin", "win32", "linux"] as const)("parking on %s", (platform) => {
  it("parking never takes focus or a taskbar slot", () => {
    // Created hidden and shown inactive by the host: no focus steal, no Dock/taskbar entry.
    expect(parkingWindow(platform, size).options).toMatchObject({
      show: false,
      focusable: false,
      skipTaskbar: true,
      frame: false,
      hasShadow: false,
    });
  });

  it("parking never opens its own full-screen Space beside a full-screen app window", () => {
    expect(parkingWindow(platform, size).options).toMatchObject({ fullscreenable: false });
  });

  it("parking asks for an offscreen spot where the OS honours one", () => {
    const { options } = parkingWindow(platform, size);
    expect({ x: options.x, y: options.y }).toEqual(parkingOrigin);
    expect(options.x).toBeLessThanOrEqual(-1_000);
  });
});

describe.each(["darwin", "win32"] as const)("parking on %s", (platform) => {
  it("a parking window takes the views' size so a parked view holds real bounds", () => {
    const parking = parkingWindow(platform, { width: 1024, height: 768 });
    expect(parking.options).toMatchObject({ width: 1024, height: 768 });
    expect(parking.growsWithViews).toBe(true);
  });

  it("parking stays invisible where the OS pulls it back on screen", () => {
    // macOS keeps a shown window on a display, so the parked page must not be seen.
    const parking = parkingWindow(platform, size);
    expect(parking.options).toMatchObject({ opacity: 0, hiddenInMissionControl: true });
    expect(parking.emptyShape).toBe(false);
  });
});

describe("parking on Linux", () => {
  it("shows the person at most one pixel, since Linux ignores opacity and Wayland positions", () => {
    const parking = parkingWindow("linux", { width: 1920, height: 1080 });
    expect(parking.options).toMatchObject({ width: 1, height: 1, resizable: false });
    // The views keep their own bounds, clipped by the pinhole; the window never grows to them.
    expect(parking.growsWithViews).toBe(false);
  });

  it("hides even that pixel where the window system has shapes (X11)", () => {
    expect(parkingWindow("linux", size).emptyShape).toBe(true);
  });
});

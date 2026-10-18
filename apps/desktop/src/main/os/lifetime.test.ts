import { expect, it } from "vitest";
import { appLifetime, type LifetimeFacts } from "./lifetime.ts";

const closed: LifetimeFacts = {
  platform: "win32",
  background: false,
  window: false,
  browserPages: 0,
  working: 0,
};

it("on Windows and Linux the app quits when its last window closes with nothing running", () => {
  expect(appLifetime(closed)).toEqual({ quit: true, tray: false });
  expect(appLifetime({ ...closed, platform: "linux" }).quit).toBe(true);
});

it("a thread's browser page keeps the app running in the tray after its last window closes", () => {
  expect(appLifetime({ ...closed, browserPages: 1 })).toEqual({ quit: false, tray: true });
});

it("a working agent keeps the app running in the tray after its last window closes", () => {
  expect(appLifetime({ ...closed, platform: "linux", working: 2 })).toEqual({
    quit: false,
    tray: true,
  });
});

it("once the last page closes and no agent works, a windowless app quits", () => {
  const busy = { ...closed, browserPages: 1, working: 1 };
  expect(appLifetime(busy).quit).toBe(false);
  expect(appLifetime({ ...busy, browserPages: 0 }).quit).toBe(false);
  expect(appLifetime({ ...busy, browserPages: 0, working: 0 }).quit).toBe(true);
});

it("the background setting keeps the app and its tray whatever runs", () => {
  expect(appLifetime({ ...closed, background: true })).toEqual({ quit: false, tray: true });
  expect(appLifetime({ ...closed, window: true, background: true }).tray).toBe(true);
});

it("macOS keeps the app open without windows and shows the tray only by setting", () => {
  expect(appLifetime({ ...closed, platform: "darwin" })).toEqual({ quit: false, tray: false });
  expect(appLifetime({ ...closed, platform: "darwin", browserPages: 3 }).tray).toBe(false);
});

it("with a window open the app never quits on its own", () => {
  expect(appLifetime({ ...closed, window: true })).toEqual({ quit: false, tray: false });
});

import { expect, test } from "vitest";
import { scrcpyRestartWorthIt } from "./scrcpy-capture.ts";

const running = { scid: 1, maxSize: 1920, bitrate: 8_000_000, fps: 60 };

test("a new size or frame rate restarts the scrcpy server at once", () => {
  expect(scrcpyRestartWorthIt(running, { ...running, maxSize: 1440 }, 0)).toBe(true);
  expect(scrcpyRestartWorthIt(running, { ...running, fps: 30 }, 0)).toBe(true);
});

test("a wavering link never keeps the view restarting: a bit rate alone must halve or grow half again, after 10 s", () => {
  expect(scrcpyRestartWorthIt(running, running, 60_000)).toBe(false);
  expect(scrcpyRestartWorthIt(running, { ...running, bitrate: 6_500_000 }, 60_000)).toBe(false);
  expect(scrcpyRestartWorthIt(running, { ...running, bitrate: 4_000_000 }, 5_000)).toBe(false);
  expect(scrcpyRestartWorthIt(running, { ...running, bitrate: 4_000_000 }, 10_000)).toBe(true);
  expect(scrcpyRestartWorthIt(running, { ...running, bitrate: 12_000_000 }, 10_000)).toBe(true);
});

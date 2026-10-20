import { expect, test } from "vitest";
import { activityCaption, screenFraction } from "./agent-activity.ts";
import { fitFrame, frameGeometry } from "./device-frame-geometry.ts";
import { filterLines, logLevel } from "./device-log-lines.ts";
import { StreamMeter, streamSummary } from "./stream-stats.ts";

test("the frame fits the room it is given and keeps the screen's aspect", () => {
  const screen = { width: 393, height: 852 };
  const geometry = frameGeometry("iphone", "iPhone 17 Pro", screen);
  for (const room of [
    { width: 300, height: 900 },
    { width: 900, height: 300 },
    { width: 120, height: 140 },
  ]) {
    const fit = fitFrame(room, geometry, screen);
    expect(fit.body.width).toBeLessThanOrEqual(room.width + 0.001);
    expect(fit.body.height).toBeLessThanOrEqual(room.height + 0.001);
    expect(fit.screen.height / fit.screen.width).toBeCloseTo(852 / 393, 5);
    // One side always touches the room's edge.
    expect(Math.max(fit.body.width / room.width, fit.body.height / room.height)).toBeCloseTo(1, 5);
  }
});

test("a small screen is never drawn larger than one pixel per point", () => {
  const screen = { width: 208, height: 248 };
  const fit = fitFrame(
    { width: 2000, height: 2000 },
    frameGeometry("watch", "Apple Watch", screen),
    screen,
  );
  expect(fit.screen.width).toBe(208);
});

test("turned on its side, an iPhone drops its island and keeps its frame even", () => {
  const upright = frameGeometry("iphone", "iPhone 17 Pro", { width: 393, height: 852 });
  const sideways = frameGeometry("iphone", "iPhone 17 Pro", { width: 852, height: 393 });
  expect(upright.cutout.kind).toBe("island");
  expect(sideways.cutout.kind).toBe("none");
  expect(new Set(Object.values(sideways.bezel)).size).toBe(1);
});

test("an agent's action reads as a short caption with its ref and the element's name", () => {
  expect(activityCaption({ action: "press", ref: "e7", label: "Sign in" })).toBe(
    "tap @e7 “Sign in”",
  );
  expect(activityCaption({ action: "longPress", ref: "@e2" })).toBe("long press @e2");
  expect(activityCaption({ action: "key", key: "home" })).toBe("press home");
  expect(activityCaption({ action: "type" })).toBe("type");
  expect(activityCaption({ action: "scroll", ref: "e9" })).toBe("scroll @e9");
  expect(activityCaption({ action: "showMenu" })).toBe("show menu");
});

test("a point lands on the shown screen as a fraction of its size, clamped to it", () => {
  expect(screenFraction({ x: 195, y: 422 }, { width: 390, height: 844 })).toEqual({
    x: 0.5,
    y: 0.5,
  });
  expect(screenFraction({ x: -4, y: 900 }, { width: 390, height: 844 })).toEqual({ x: 0, y: 1 });
  expect(screenFraction({ x: 1, y: 1 }, { width: 0, height: 844 })).toBeUndefined();
});

test("log lines take their level from logcat's letter or from the words in them", () => {
  expect(logLevel("10-19 12:00:00.000  123  456 E ActivityManager: ANR in com.example")).toBe(
    "error",
  );
  expect(logLevel("W/Choreographer( 123): Skipped 30 frames")).toBe("warning");
  expect(logLevel("10-19 12:00:00.000  123  456 I Zygote: Process started")).toBe("info");
  expect(logLevel("12:00:01 SpringBoard[42] <Error>: Failed to load")).toBe("error");
  expect(logLevel("12:00:01 MyApp: warning: low memory")).toBe("warning");
  expect(logLevel("12:00:01 SpringBoard launched")).toBe("info");
});

test("the log filter keeps lines containing its text, ignoring case", () => {
  const lines = ["Network reachable", "SpringBoard launched", "network lost"];
  expect(filterLines(lines, "NETWORK")).toEqual(["Network reachable", "network lost"]);
  expect(filterLines(lines, "  ")).toBe(lines);
});

test("the stream's subtitle counts the last second's frames and their delay on one machine", () => {
  const meter = new StreamMeter({ sameClock: true });
  for (let at = 0; at <= 1500; at += 25)
    meter.add({ codec: "h264", capturedAt: at - 30, shownAt: at });
  expect(streamSummary(meter.read(1500))).toEqual(["H.264", "40 fps", "30 ms"]);
});

test("the subtitle leaves out what it can't know: the rate in the first second, a remote delay", () => {
  const remote = new StreamMeter({ sameClock: false });
  remote.add({ codec: "jpeg", capturedAt: 0, shownAt: 100 });
  expect(streamSummary(remote.read(200))).toEqual(["JPEG"]);
  expect(streamSummary(remote.read(5000))).toEqual(["JPEG"]);
  expect(streamSummary(new StreamMeter({ sameClock: true }).read(0))).toEqual([]);
});

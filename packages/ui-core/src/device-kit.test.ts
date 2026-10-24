import { expect, test } from "vitest";
import {
  activityCaption,
  deviceScreen,
  filterLines,
  fitFrame,
  frameGeometry,
  logLevel,
  screenFraction,
  shortRefs,
} from "./device-kit.ts";

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

/** A frame's screen corner radius in points, for a screen `width` points wide. */
const cornerPoints = (name: string, screen: { width: number; height: number }) =>
  frameGeometry(name.startsWith("iPad") ? "ipad" : "iphone", name, screen).screenRadius *
  screen.width;

test("each iPhone's screen corners match its own display, whatever size its picture arrives at", () => {
  expect(cornerPoints("iPhone 17 Pro", { width: 402, height: 874 })).toBeCloseTo(62, 5);
  expect(cornerPoints("iPhone 16 Pro Max", { width: 440, height: 956 })).toBeCloseTo(62, 5);
  expect(cornerPoints("iPhone 15", { width: 393, height: 852 })).toBeCloseTo(55, 5);
  expect(cornerPoints("iPhone 14 Pro", { width: 393, height: 852 })).toBeCloseTo(55, 5);
  expect(cornerPoints("iPhone 13", { width: 390, height: 844 })).toBeCloseTo(47.33, 5);
  expect(cornerPoints("iPhone 16e", { width: 390, height: 844 })).toBeCloseTo(47.33, 5);
  expect(cornerPoints("iPhone 11", { width: 414, height: 896 })).toBeCloseTo(41.5, 5);
  expect(cornerPoints("iPhone SE (3rd generation)", { width: 375, height: 667 })).toBe(0);
  // Turned sideways the screen is as round as upright.
  expect(cornerPoints("iPhone 17 Pro", { width: 874, height: 402 })).toBeCloseTo(62, 5);
});

test("an iPhone or iPad ace doesn't know is drawn as the current generation", () => {
  expect(deviceScreen("iphone", "iPhone 42 Ultra")).toEqual(deviceScreen("iphone", "iPhone 17 Pro"));
  expect(cornerPoints("iPhone 42 Ultra", { width: 402, height: 874 })).toBeCloseTo(62, 5);
  expect(cornerPoints("iPad Something", { width: 820, height: 1180 })).toBeCloseTo(18, 5);
});

test("before its first picture, a device's screen has its own model's size", () => {
  expect(deviceScreen("iphone", "iPhone 17 Pro Max")).toEqual({ width: 440, height: 956 });
  expect(deviceScreen("iphone", "iPhone Air")).toEqual({ width: 420, height: 912 });
  expect(deviceScreen("ipad", "iPad Pro 13-inch (M4)")).toEqual({ width: 1032, height: 1376 });
  expect(deviceScreen("ipad", "iPad mini (A17 Pro)")).toEqual({ width: 744, height: 1133 });
});

test("a Face ID iPhone's body is evenly bordered and its corners sit concentric around the screen", () => {
  const geometry = frameGeometry("iphone", "iPhone 17 Pro", { width: 402, height: 874 });
  expect(new Set(Object.values(geometry.bezel)).size).toBe(1);
  expect(geometry.bodyRadius).toBeCloseTo(geometry.screenRadius + geometry.bezel.left, 10);
  expect(geometry.homeButton).toBe(false);
});

test("a home-button face keeps its chin below the screen and moves it to the sides when turned", () => {
  const upright = frameGeometry("iphone", "iPhone SE (3rd generation)", { width: 375, height: 667 });
  const sideways = frameGeometry("iphone", "iPhone 8", { width: 667, height: 375 });
  expect(upright.homeButton).toBe(true);
  expect(upright.bezel.top).toBeGreaterThan(upright.bezel.left * 3);
  expect(sideways.bezel.left).toBeGreaterThan(sideways.bezel.top * 3);
  expect(frameGeometry("ipad", "iPad (9th generation)", { width: 810, height: 1080 }).homeButton).toBe(
    true,
  );
  expect(frameGeometry("ipad", "iPad (A16)", { width: 820, height: 1180 }).homeButton).toBe(false);
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

const refsOf = (nodes: ReturnType<typeof shortRefs>): unknown[] =>
  nodes.map((entry) => [entry.node.name, entry.ref, refsOf(entry.children)]);

const leaf = (ref: string, name: string, actions: "press"[] = ["press"]) => ({
  ref,
  role: "Button",
  name,
  bounds: { x: 0, y: 0, w: 1, h: 1 },
  states: [],
  actions,
  children: [],
});

test("the UI tree numbers the elements agents can act on as agents do, children before parents", () => {
  const tree = shortRefs([
    {
      ...leaf("ax-cell", "Wi-Fi"),
      children: [leaf("ax-toggle", "Switch"), leaf("ax-label", "Label", [])],
    },
    leaf("ax-done", "Done"),
  ]);
  expect(refsOf(tree)).toEqual([
    [
      "Wi-Fi",
      "e2",
      [
        ["Switch", "e1", []],
        ["Label", undefined, []],
      ],
    ],
    ["Done", "e3", []],
  ]);
});

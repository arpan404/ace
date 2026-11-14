import { expect, test } from "vitest";
import { BrowserClientMessage } from "./browser.ts";
import { DeviceClientMessage } from "./devices.ts";
import { ScreenClientMessage } from "./screen.ts";

const link = {
  effectiveType: "3g",
  downlinkKbps: 1_600,
  rttMs: 400,
  saveData: true,
  expensive: true,
  constrained: false,
};
const viewport = { width: 390, height: 844, devicePixelRatio: 3 };
const threadId = "thread-1";

function subscribe(hint: unknown) {
  return BrowserClientMessage.safeParse({
    type: "browser.subscribe",
    requestId: "r",
    threadId,
    binaryFrames: true,
    viewport: { ...viewport, link: hint },
    video: { codecs: ["avc1.42E033"] },
  });
}

test("a browser viewer's link hint and pause travel on its subscribe and its capture reports", () => {
  const subscribed = subscribe(link);
  expect(subscribed.success && subscribed.data.type === "browser.subscribe").toBe(true);
  if (subscribed.success && subscribed.data.type === "browser.subscribe")
    expect(subscribed.data.viewport?.link).toEqual(link);
  const capture = {
    type: "browser.capture",
    requestId: "r",
    threadId,
    viewport: { ...viewport, paused: true, link: { rttMs: 450 } },
  };
  expect(BrowserClientMessage.parse(capture)).toEqual(capture);
  expect(BrowserClientMessage.parse({ ...capture, viewport })).toEqual({ ...capture, viewport });
});

test("device and screen subscribes carry a link hint, and parse without one", () => {
  for (const operation of [
    { op: "subscribe", deviceId: "android:emulator-5554", link },
    { op: "subscribe", deviceId: "android:emulator-5554" },
  ]) {
    const message = { type: "devices.request", requestId: "r", operation };
    expect(DeviceClientMessage.parse(message)).toEqual(message);
  }
  for (const operation of [
    { op: "subscribe", sessionId: "s", link: { saveData: true } },
    { op: "subscribe", sessionId: "s" },
  ]) {
    const message = { type: "screen.request", requestId: "r", operation };
    expect(ScreenClientMessage.parse(message)).toEqual(message);
  }
});

test("a later client's link names still parse: open effective types, unknown fields dropped", () => {
  const parsed = subscribe({ effectiveType: "5g", futureSignal: 1 });
  expect(parsed.success).toBe(true);
  if (parsed.success && parsed.data.type === "browser.subscribe")
    expect(parsed.data.viewport?.link).toEqual({ effectiveType: "5g" });
});

/** The hint a subscribe kept, or a failure if the subscribe itself was refused. */
function kept(hint: unknown) {
  const parsed = subscribe(hint);
  if (!parsed.success || parsed.data.type !== "browser.subscribe") throw new Error("refused");
  return parsed.data.viewport?.link;
}

test("a computed number is rounded and an out-of-range one clamped, keeping the hint", () => {
  expect(kept({ downlinkKbps: 1.1 * 1_000, rttMs: 412.6 })).toEqual({
    downlinkKbps: 1_100,
    rttMs: 413,
  });
  expect(kept({ downlinkKbps: 1e12, rttMs: -5 })).toEqual({ downlinkKbps: 10_000_000, rttMs: 0 });
});

test.each([
  ["a null field", { rttMs: null, saveData: true }],
  ["a string round trip", { rttMs: "400", saveData: true }],
  ["an empty effective type", { effectiveType: "", saveData: true }],
  ["an overlong effective type", { effectiveType: "x".repeat(17), saveData: true }],
  ["a numeric flag", { expensive: 1, saveData: true }],
])("a hint with %s still subscribes, without that field", (_, hint) => {
  expect(kept(hint)).toEqual({ saveData: true });
});

test.each([
  ["an explicit null", null],
  ["a number", 3],
  ["a string", "3g"],
  ["an array", [{ rttMs: 400 }]],
])("a link that is %s still subscribes, without a hint", (_, hint) => {
  expect(kept(hint)).toBeUndefined();
});

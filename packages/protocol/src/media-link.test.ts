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

test.each([
  ["an explicit null", null],
  ["a null field", { rttMs: null }],
  ["a negative downlink", { downlinkKbps: -1 }],
  ["a fractional round trip", { rttMs: 1.5 }],
  ["a downlink past 10 Gbit/s", { downlinkKbps: 10_000_001 }],
  ["a round trip past a minute", { rttMs: 60_001 }],
  ["an empty effective type", { effectiveType: "" }],
  ["an overlong effective type", { effectiveType: "x".repeat(17) }],
  ["a numeric flag", { saveData: 1 }],
])("a link hint with %s is refused at the boundary", (_, hint) => {
  expect(subscribe(hint).success).toBe(false);
});

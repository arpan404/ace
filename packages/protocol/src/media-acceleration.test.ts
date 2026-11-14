import { expect, test } from "vitest";
import { BrowserState } from "./browser.ts";
import { DeviceState } from "./devices.ts";
import { ScreenState } from "./screen.ts";
import { ScreenCapabilities } from "./screen-v2.ts";

// A newer daemon's step and backend names must still parse here.
const acceleration = {
  steps: [
    { step: "jpeg-decode", backend: "cpu", hardware: false, readbacks: 0, uploads: 1 },
    { step: "future-step", backend: "future-gpu", hardware: true, readbacks: 0, uploads: 0 },
  ],
  degraded: true,
  reason: "watchdog",
};
const browser = { threadId: "thread-1", url: "https://example.com/", closed: false };
const device = {
  device: { id: "android:emulator-5554", platform: "android", name: "Pixel", state: "booted" },
  enabled: true,
  lifecycle: "live",
  controller: "none",
};
const screen = {
  sessionId: "session-1",
  lifecycle: "live",
  controller: "none",
  mode: "background",
  secureInputAllowed: false,
  indicator: true,
  target: { kind: "display", displayId: 1, bundleIds: ["com.example.app"] },
  permissions: { screenRecording: true, accessibility: true },
};

test.each([
  ["browser", BrowserState, browser],
  ["device", DeviceState, device],
  ["screen", ScreenState, screen],
] as const)(
  "%s state keeps what its live video runs on, and parses without it",
  (_, schema, state) => {
    expect(schema.parse(state)).not.toHaveProperty("acceleration");
    expect(schema.parse({ ...state, acceleration }).acceleration).toEqual(acceleration);
    expect(schema.safeParse({ ...state, acceleration: { steps: [] } }).success).toBe(false);
  },
);

test.each([
  ["browser", BrowserState, browser],
  ["device", DeviceState, device],
  ["screen", ScreenState, screen],
] as const)("older %s clients ignore acceleration", (_, schema, state) => {
  const older = schema.omit({ acceleration: true });
  expect(older.parse({ ...state, acceleration })).not.toHaveProperty("acceleration");
});

test("a helper hello reports capture → encode, and older hellos without it still parse", () => {
  const hello = {
    version: 2,
    platform: "linux-wayland",
    capture: { windows: true, displays: true, changeDriven: true },
    input: { pointer: true, keyboard: true, scroll: true, text: true },
    uiTree: false,
    semanticActions: [],
    codecs: ["h264"],
    permissions: { screen: "granted", input: "granted" },
  };
  const encoders = [
    {
      step: "encode",
      codec: "avc1.42e01f",
      backend: "vaapi",
      hardware: true,
      zeroCopy: false,
      state: "ok",
      maxWidth: 4096,
      maxHeight: 4096,
    },
    {
      step: "encode",
      codec: "avc1.42e01f",
      backend: "nv",
      hardware: false,
      zeroCopy: false,
      state: "timed-out",
      maxWidth: 0,
      maxHeight: 0,
    },
  ];
  expect(ScreenCapabilities.parse(hello).encoders).toBeUndefined();
  expect(ScreenCapabilities.parse({ ...hello, encoders }).encoders).toEqual(encoders);
  expect(
    ScreenCapabilities.safeParse({ ...hello, encoders: [{ ...encoders[0], zeroCopy: "yes" }] })
      .success,
  ).toBe(false);
});

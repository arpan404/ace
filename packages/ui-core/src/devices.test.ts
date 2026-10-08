import { AppDevice, DeviceState, ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  deviceProblem,
  deviceControls,
  deviceGesture,
  devicePoint,
  deviceRows,
  leaseLeft,
} from "./devices.ts";

const iphone = AppDevice.parse({
  id: "ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b",
  platform: "ios",
  name: "iPhone 16 Pro",
  state: "booted",
  runtime: "iOS 18.4",
});
const pixel = AppDevice.parse({
  id: "android:Pixel_9_API_35",
  platform: "android",
  name: "Pixel 9",
  state: "shutdown",
  runtime: "Android 15",
});
const state = (extra: Partial<DeviceState> = {}) =>
  DeviceState.parse({
    device: iphone,
    enabled: true,
    approved: false,
    lifecycle: "idle",
    controller: "none",
    ...extra,
  });

test("the list shows iOS then Android, running devices first, with runtime and state", () => {
  const rows = deviceRows([iphone, pixel], [state({ lifecycle: "live", streamId: "s1" })]);

  expect(rows.map((row) => [row.name, row.detail, row.live])).toEqual([
    ["iPhone 16 Pro", "iOS 18.4 · Running", true],
    ["Pixel 9", "Android 15 · Off", false],
  ]);
});

test("a device approved for another thread says so, and approval here is separate", () => {
  const here = ThreadId.parse("thread-here");
  const other = deviceControls(
    iphone,
    state({ approved: true, threadId: ThreadId.parse("x") }),
    here,
    0,
  );
  const mine = deviceControls(iphone, state({ approved: true, threadId: here }), here, 0);

  expect([other.approvedHere, other.approvedElsewhere]).toEqual([false, true]);
  expect([mine.approvedHere, mine.approvedElsewhere]).toEqual([true, false]);
});

test("control is yours only until the lease runs out", () => {
  const leased = state({ lifecycle: "live", controller: "human", leaseExpiresAt: 10_000 });

  const during = deviceControls(iphone, leased, "t", 4_000);
  expect(during.inControl).toBe(true);
  expect(during.status).toBe("Live · You're in control");
  expect(leaseLeft(during.leaseLeftMs)).toBe("0:06");

  const after = deviceControls(iphone, leased, "t", 10_000);
  expect(after.inControl).toBe(false);
  expect(after.status).toBe("Live · Your control ended");
});

test("an agent driving the device is named in the status", () => {
  expect(deviceControls(iphone, state({ controller: "agent" }), "t", 0).status).toBe(
    "Running · The agent is in control",
  );
  expect(deviceControls(pixel, undefined, "t", 0).status).toBe("Off");
});

test("a pointer on a frame drawn at half size lands on the matching device point", () => {
  const frame = { width: 780, height: 1688, scale: 2 };
  const shown = { left: 100, top: 50, width: 195, height: 422 };

  expect(devicePoint(frame, shown, { x: 100 + 97.5, y: 50 + 211 })).toEqual({ x: 195, y: 422 });
  expect(devicePoint(frame, shown, { x: 0, y: 9999 })).toEqual({ x: 0, y: 843 });
  expect(devicePoint(frame, { ...shown, width: 0 }, { x: 1, y: 1 })).toBeUndefined();
});

test("a quick press is a tap, a held one a long press, a dragged one a swipe", () => {
  expect(deviceGesture({ x: 10, y: 10, at: 0 }, { x: 12, y: 11, at: 120 })).toEqual({
    kind: "tap",
    x: 12,
    y: 11,
  });
  expect(deviceGesture({ x: 10, y: 10, at: 0 }, { x: 10, y: 10, at: 800 })).toEqual({
    kind: "longPress",
    x: 10,
    y: 10,
    durationMs: 800,
  });
  expect(deviceGesture({ x: 10, y: 600, at: 0 }, { x: 10, y: 100, at: 300 })).toEqual({
    kind: "swipe",
    x: 10,
    y: 600,
    toX: 10,
    toY: 100,
    durationMs: 300,
  });
});

test("a device booted since the list was read shows as running", () => {
  const booted = AppDevice.parse({ ...pixel, state: "booted" });
  const rows = deviceRows([pixel], [state({ device: booted })]);

  expect(rows.map((row) => [row.name, row.running])).toEqual([["Pixel 9", true]]);
});

test("device tool failures offer a fix without exposing internal errors", () => {
  expect(
    deviceProblem({
      code: "command_failed",
      message: "raw_id: internal JSON failure",
      hint: "ACE_WORKSPACE_ROOT",
    }),
  ).toEqual({
    message: "The device action didn't finish.",
    hint: "Check that the device is running, then try again.",
  });
  expect(
    deviceProblem({
      code: "permission_denied",
      permission: "screenRecording",
      message: "Screen Recording is needed",
      hint: "Open macOS privacy settings",
    }),
  ).toEqual({
    permission: "screenRecording",
    message: "Screen Recording is needed",
    hint: "Open macOS privacy settings",
  });
});

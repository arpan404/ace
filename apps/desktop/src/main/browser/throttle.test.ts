import { expect, it } from "vitest";
import { throttleDecision, type ViewActivity } from "./throttle.ts";

const idleMs = 30_000;
const hiddenIdle: ViewActivity = {
  visible: false,
  nativeInput: false,
  screencasting: false,
  lastDrivenAt: 0,
};

it("throttles a hidden view the agent has left alone", () => {
  expect(throttleDecision(hiddenIdle, 60_000, idleMs)).toEqual({ throttle: true });
});

it("keeps a hidden view at full speed while the agent drives it, until it goes quiet", () => {
  const driven = { ...hiddenIdle, lastDrivenAt: 50_000 };
  expect(throttleDecision(driven, 60_000, idleMs)).toEqual({
    throttle: false,
    recheckInMs: 20_000,
  });
  expect(throttleDecision(driven, 80_000, idleMs)).toEqual({ throttle: true });
});

it("never throttles a view on screen, under the person's control, or being screencast", () => {
  for (const activity of [
    { ...hiddenIdle, visible: true },
    { ...hiddenIdle, nativeInput: true },
    { ...hiddenIdle, screencasting: true },
  ])
    expect(throttleDecision(activity, 600_000, idleMs)).toEqual({ throttle: false });
});

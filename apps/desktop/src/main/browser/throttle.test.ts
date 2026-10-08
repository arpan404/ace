import { expect, it } from "vitest";
import { throttleDecision, type ViewActivity } from "./throttle.ts";

const idleMs = 30_000;
const hiddenIdle: ViewActivity = {
  visible: false,
  nativeInput: false,
  agentControl: true,
  screencasting: false,
  lastDrivenAt: 0,
};

it("throttles a hidden view the agent has left alone and stops it rendering", () => {
  expect(throttleDecision(hiddenIdle, 60_000, idleMs)).toEqual({
    presence: "hidden",
    throttle: true,
  });
});

it("keeps an unseen view rendering at full speed while the agent drives it, until it goes quiet", () => {
  const driven = { ...hiddenIdle, lastDrivenAt: 50_000 };
  expect(throttleDecision(driven, 60_000, idleMs)).toEqual({
    presence: "parked",
    throttle: false,
    recheckInMs: 20_000,
  });
  expect(throttleDecision(driven, 80_000, idleMs)).toEqual({ presence: "hidden", throttle: true });
});

it("renders a view the person sees in place, even while the agent drives it", () => {
  expect(
    throttleDecision({ ...hiddenIdle, visible: true, lastDrivenAt: 59_000 }, 60_000, idleMs),
  ).toEqual({ presence: "placed", throttle: false });
});

it("does not render an unseen view a person drives, though it stays at full speed", () => {
  expect(
    throttleDecision({ ...hiddenIdle, agentControl: false, lastDrivenAt: 59_000 }, 60_000, idleMs),
  ).toEqual({ presence: "hidden", throttle: false, recheckInMs: 29_000 });
});

it("never throttles a view under the person's control or being screencast", () => {
  for (const activity of [
    { ...hiddenIdle, nativeInput: true },
    { ...hiddenIdle, screencasting: true },
  ])
    expect(throttleDecision(activity, 600_000, idleMs)).toEqual({
      presence: "hidden",
      throttle: false,
    });
});

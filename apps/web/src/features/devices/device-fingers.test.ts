import { expect, test } from "vitest";
import { TouchGestures, type TouchEffect } from "@/lib/touch-gestures.ts";
import { DeviceFingers, pinchPartner } from "./device-fingers.ts";

const at = (x: number, y: number) => ({ screen: { x, y }, page: { x, y } });

/** What a device gets from a touch sequence read by the shared gesture reader. */
function driven(multi: boolean) {
  const gestures = new TouchGestures();
  const fingers = new DeviceFingers(multi);
  const inputs = (effects: TouchEffect[]) =>
    effects.flatMap((effect) => (effect.type === "input" ? fingers.touch(effect.input) : []));
  return { gestures, fingers, inputs };
}

test("two real fingers pinching reach a multi-touch device as their own pointers", () => {
  const { gestures, inputs } = driven(true);
  expect([
    ...inputs(gestures.down(11, at(100, 100), 0)),
    ...inputs(gestures.down(12, at(200, 200), 10)),
    ...inputs(gestures.move(12, at(260, 260))),
    ...inputs(gestures.up(11, at(100, 100), 50)),
    ...inputs(gestures.up(12, at(260, 260), 60)),
  ]).toEqual([
    { kind: "pointer", phase: "down", x: 100, y: 100, pointerId: 0 },
    { kind: "pointer", phase: "down", x: 200, y: 200, pointerId: 1 },
    { kind: "pointer", phase: "move", x: 260, y: 260, pointerId: 1 },
    { kind: "pointer", phase: "up", x: 100, y: 100, pointerId: 0 },
    { kind: "pointer", phase: "up", x: 260, y: 260, pointerId: 1 },
  ]);
});

test("a one-finger device follows the first finger only, without pointer ids", () => {
  const { gestures, inputs } = driven(false);
  expect([
    ...inputs(gestures.down(1, at(10, 10), 0)),
    ...inputs(gestures.down(2, at(50, 50), 5)),
    ...inputs(gestures.move(2, at(60, 60))),
    ...inputs(gestures.move(1, at(30, 30))),
    ...inputs(gestures.up(2, undefined, 20)),
    ...inputs(gestures.up(1, at(30, 30), 30)),
  ]).toEqual([
    { kind: "pointer", phase: "down", x: 10, y: 10 },
    { kind: "pointer", phase: "move", x: 30, y: 30 },
    { kind: "pointer", phase: "up", x: 30, y: 30 },
  ]);
});

test("a cancelled sequence lifts every held finger as a cancel", () => {
  const { gestures, fingers, inputs } = driven(true);
  inputs(gestures.down(1, at(10, 10), 0));
  inputs(gestures.down(2, at(20, 20), 0));
  expect(inputs(gestures.cancel())).toEqual([
    { kind: "pointer", phase: "cancel", x: 10, y: 10, pointerId: 0 },
    { kind: "pointer", phase: "cancel", x: 20, y: 20, pointerId: 1 },
  ]);
  expect(fingers.held).toBe(0);
});

test("a mouse pinch's second finger mirrors the pointer through the screen's middle", () => {
  const screen = { width: 390, height: 844 };
  expect(pinchPartner({ x: 0, y: 0 }, screen)).toEqual({ x: 389, y: 843 });
  expect(pinchPartner({ x: 195, y: 422 }, screen)).toEqual({ x: 194, y: 421 });
});

import { expect, it } from "vitest";
import { fingerDown, fingerMove, fingerUp, noFingers } from "./simulator-fingers.ts";

it("a finger that starts on a screen edge keeps its edge gesture until it lifts", () => {
  const down = fingerDown(noFingers, 0, { x: 0.5, y: 0.99 }, 3);
  const moved = fingerMove(down.held, 0, { x: 0.5, y: 0.6 });
  expect([...down.messages, ...moved.messages, ...fingerUp(moved.held, 0).messages]).toEqual([
    { tag: 3, payload: { type: "begin", x: 0.5, y: 0.99, edge: 3 } },
    { tag: 3, payload: { type: "move", x: 0.5, y: 0.6, edge: 3 } },
    { tag: 3, payload: { type: "end", x: 0.5, y: 0.6, edge: 3 } },
  ]);
});

it("a second finger joins the held touch without lifting it, behind the finger already down", () => {
  const first = fingerDown(noFingers, 1, { x: 0.5, y: 0.9 }, 0);
  expect(fingerDown(first.held, 0, { x: 0.2, y: 0.3 }, 0).messages).toEqual([
    { tag: 5, payload: { type: "begin", x1: 0.5, y1: 0.9, x2: 0.2, y2: 0.3 } },
  ]);
});

it("lifting two fingers one after the other ends the two-finger touch without a stray tap", () => {
  const first = fingerDown(noFingers, 0, { x: 0.5, y: 0.2 }, 0);
  const pair = fingerDown(first.held, 1, { x: 0.5, y: 0.8 }, 0);
  const lifted = fingerUp(pair.held, 0);
  expect([...lifted.messages, ...fingerUp(lifted.held, 1).messages]).toEqual([
    { tag: 5, payload: { type: "end", x1: 0.5, y1: 0.2, x2: 0.5, y2: 0.8 } },
  ]);
  expect(fingerUp(lifted.held, 1).held).toEqual(noFingers);
});

it("lifting a finger that is not down sends nothing, and moving one is refused", () => {
  const one = fingerDown(noFingers, 0, { x: 0.1, y: 0.1 }, 0).held;
  expect(fingerUp(one, 1)).toEqual({ held: one, messages: [] });
  expect(fingerUp(noFingers, 0)).toEqual({ held: noFingers, messages: [] });
  expect(() => fingerMove(one, 1, { x: 0.2, y: 0.2 })).toThrow("not held");
  expect(() => fingerMove(noFingers, 0, { x: 0.2, y: 0.2 })).toThrow("not held");
});

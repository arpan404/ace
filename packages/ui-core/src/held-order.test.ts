import { expect, test } from "vitest";
import { holdOrder, ListHold, type Timers } from "./held-order.ts";

interface Row {
  id: string;
  kind: string;
  needsYou?: boolean;
}
const rows = (spec: string) =>
  spec
    .split(" ")
    .map((id): Row => ({ id: id.replace("!", ""), kind: "thread", needsYou: id.endsWith("!") }));
const ids = (list: readonly Row[]) => list.map((row) => row.id).join(" ");
const key = (row: Row) => row.id;
const never = () => false;
const needsYou = (row: Row) => row.needsYou === true;

test("rows that stay keep the places they were drawn in", () => {
  expect(ids(holdOrder(rows("a b c"), rows("c a b"), key, never))).toBe("a b c");
});

test("a new row comes in right after the row before it in the new order", () => {
  expect(ids(holdOrder(rows("a b c"), rows("c a d b"), key, never))).toBe("a d b c");
  expect(ids(holdOrder(rows("a b"), rows("d b a"), key, never))).toBe("d a b");
});

test("a row that is gone leaves without moving the others", () => {
  expect(ids(holdOrder(rows("a b c"), rows("c a"), key, never))).toBe("a c");
});

test("a freed row goes where the new order puts it while the rest hold", () => {
  expect(ids(holdOrder(rows("a b c d"), rows("d! c a b"), key, needsYou))).toBe("d a b c");
});

test("each row drawn is the new list's copy", () => {
  const shown = [{ id: "a", kind: "thread" }];
  const next = [{ id: "a", kind: "pinned" }];
  expect(holdOrder(shown, next, key, never)[0]).toBe(next[0]);
});

test("nothing drawn yet: the new order as it is", () => {
  expect(ids(holdOrder([], rows("b a"), key, never))).toBe("b a");
});

/** Timers a test steps by hand. */
function manualTimers() {
  let pending: { at: number; run: () => void } | undefined;
  let now = 0;
  const timers: Timers = {
    set(delayMs, run) {
      const timer = { at: now + delayMs, run };
      pending = timer;
      return () => {
        if (pending === timer) pending = undefined;
      };
    },
  };
  return {
    timers,
    advance(ms: number) {
      now += ms;
      if (pending && pending.at <= now) {
        const { run } = pending;
        pending = undefined;
        run();
      }
    },
  };
}

test("the list holds while the pointer is over it and lets go 600 ms after it leaves", () => {
  const clock = manualTimers();
  const hold = new ListHold(clock.timers);
  expect(hold.getState().held).toBe(false);
  hold.pointer(true);
  expect(hold.getState()).toEqual({ held: true, rise: false });
  hold.pointer(false);
  clock.advance(599);
  // Still held after the pointer left, but a row that needs you may rise now.
  expect(hold.getState()).toEqual({ held: true, rise: true });
  clock.advance(1);
  expect(hold.getState().held).toBe(false);
});

test("coming back before the 600 ms are up keeps the hold", () => {
  const clock = manualTimers();
  const hold = new ListHold(clock.timers);
  hold.pointer(true);
  hold.pointer(false);
  clock.advance(400);
  hold.pointer(true);
  clock.advance(1_000);
  expect(hold.getState()).toEqual({ held: true, rise: false });
});

test("keyboard focus in the list holds it without the pointer, and rows that need you rise", () => {
  const clock = manualTimers();
  const hold = new ListHold(clock.timers);
  hold.focus(true);
  clock.advance(5_000);
  expect(hold.getState()).toEqual({ held: true, rise: true });
  hold.focus(false);
  clock.advance(600);
  expect(hold.getState().held).toBe(false);
});

test("listeners hear each change of hold", () => {
  const clock = manualTimers();
  const hold = new ListHold(clock.timers);
  const seen: boolean[] = [];
  hold.subscribe(() => seen.push(hold.getState().held));
  hold.pointer(true);
  hold.pointer(false);
  clock.advance(600);
  expect(seen).toEqual([true, true, false]);
});

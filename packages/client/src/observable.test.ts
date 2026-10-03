import { expect, test } from "vitest";
import { Notifications } from "./observable.ts";

/** A store with two fields and their keys, counting how often a selection reads it. */
function store() {
  const notifications = new Notifications(64);
  const state = { a: 1, b: 1 };
  let reads = 0;
  const selectA = () =>
    notifications.select(
      ["a"],
      () => {
        reads++;
        return { a: state.a };
      },
      (x, y) => x.a === y.a,
    );
  return {
    notifications,
    state,
    selectA,
    reads: () => reads,
    set(key: "a" | "b", value: number) {
      state[key] = value;
      notifications.emit([key]);
    },
  };
}

test("a subscribed selection renders again for free until one of its keys changes", () => {
  const s = store();
  const selection = s.selectA();
  const stop = selection.subscribe(() => {});
  const before = s.reads();
  const first = selection.getSnapshot();
  for (let render = 0; render < 100; render++) expect(selection.getSnapshot()).toBe(first);
  s.set("b", 2);
  expect(selection.getSnapshot()).toBe(first);
  expect(s.reads()).toBe(before);
  s.set("a", 2);
  expect(selection.getSnapshot()).toEqual({ a: 2 });
  stop();
});

test("an unsubscribed selection reads again only after its store changed", () => {
  const s = store();
  const selection = s.selectA();
  const before = s.reads();
  selection.getSnapshot();
  selection.getSnapshot();
  expect(s.reads()).toBe(before);
  s.set("a", 3);
  expect(selection.getSnapshot()).toEqual({ a: 3 });
  const stop = selection.subscribe(() => {});
  stop();
  s.set("a", 4);
  expect(selection.getSnapshot()).toEqual({ a: 4 });
});

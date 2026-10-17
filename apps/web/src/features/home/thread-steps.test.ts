import { expect, test } from "vitest";
import { threadAfterLeaving } from "./thread-steps.tsx";

test("a thread leaving the list hands over to the one after it, or the one before when it was last", () => {
  const order = ["a", "b", "c"];
  expect(threadAfterLeaving(order, "a")).toBe("b");
  expect(threadAfterLeaving(order, "b")).toBe("c");
  expect(threadAfterLeaving(order, "c")).toBe("b");
});

test("the last thread leaving hands over to none, and an unlisted one to the top of the list", () => {
  expect(threadAfterLeaving(["a"], "a")).toBeUndefined();
  expect(threadAfterLeaving([], "a")).toBeUndefined();
  expect(threadAfterLeaving(["b", "c"], "a")).toBe("b");
});

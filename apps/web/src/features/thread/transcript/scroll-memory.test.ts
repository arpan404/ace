import { expect, test } from "vitest";
import { createScrollMemory, restoreAt, type SavedScroll } from "./scroll-memory.ts";

const left = (key: string, lastKey: string, offset = -40): SavedScroll => ({
  key,
  offset,
  lastKey,
  measured: [],
});

test("going back to a thread with nothing new reopens at the row the reader left, at its offset", () => {
  const memory = createScrollMemory();
  memory.save("t1", left("b", "d"));
  expect(restoreAt(memory.peek("t1"), ["a", "b", "c", "d"])).toEqual({ index: 1, offset: -40 });
});

test("a thread that got new items since reopens at its live end", () => {
  const memory = createScrollMemory();
  memory.save("t1", left("b", "d"));
  expect(restoreAt(memory.peek("t1"), ["a", "b", "c", "d", "e"])).toBeUndefined();
});

test("a thread left at its live end, or never left, opens at the end", () => {
  const memory = createScrollMemory();
  memory.save("t1", left("b", "d"));
  memory.save("t1", undefined);
  expect(restoreAt(memory.peek("t1"), ["a", "b", "c", "d"])).toBeUndefined();
  expect(restoreAt(memory.peek("t2"), ["a"])).toBeUndefined();
});

test("a saved row that is no longer there opens at the end", () => {
  expect(restoreAt(left("gone", "d"), ["a", "c", "d"])).toBeUndefined();
});

test("only the most recently left threads are remembered", () => {
  const memory = createScrollMemory(2);
  memory.save("t1", left("a", "a"));
  memory.save("t2", left("a", "a"));
  memory.save("t3", left("a", "a"));
  expect(memory.peek("t1")).toBeUndefined();
  expect(memory.peek("t2")).toBeDefined();
  expect(memory.peek("t3")).toBeDefined();
});

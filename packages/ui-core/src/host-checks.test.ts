import { expect, test } from "vitest";
import { admissionWords } from "./host-checks.ts";

test("a machine taking new work offers to pause it and shows no line", () => {
  expect(admissionWords({ paused: false, busy: 3 })).toEqual({
    line: null,
    action: "Pause new work",
  });
});

test("a paused machine says how much running work is still finishing", () => {
  expect(admissionWords({ paused: true, busy: 0 }).line).toBe(
    "New work paused · nothing is running",
  );
  expect(admissionWords({ paused: true, busy: 1 }).line).toBe(
    "New work paused · 1 thread is finishing",
  );
  expect(admissionWords({ paused: true, busy: 4 })).toEqual({
    line: "New work paused · 4 threads are finishing",
    action: "Resume new work",
  });
});

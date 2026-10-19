import { expect, test } from "vitest";
import { presenceLead, presenceWords } from "./pr-presence.ts";

test("a task still working outranks one that is done", () => {
  expect(
    presenceLead([
      { id: "a", tone: "done" as const },
      { id: "b", tone: "working" as const },
    ])?.id,
  ).toBe("b");
});

test("a task that needs the person outranks every other state", () => {
  expect(
    presenceLead([
      { id: "a", tone: "working" as const },
      { id: "b", tone: "failed" as const },
      { id: "c", tone: "needs-you" as const },
    ])?.id,
  ).toBe("c");
});

test("no linked tasks lead nothing", () => {
  expect(presenceLead([])).toBeUndefined();
});

test("a working task says how long it has worked; others say their state", () => {
  expect(presenceWords({ label: "Working", tone: "working" }, "3m")).toBe("working 3m");
  expect(presenceWords({ label: "Needs you", tone: "needs-you" }, "3m")).toBe("needs you");
});

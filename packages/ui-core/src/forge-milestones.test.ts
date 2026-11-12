import { expect, test } from "vitest";
import { milestoneDue } from "./forge-milestones.ts";

test("a milestone's due date reads as the day GitHub set, whatever the reader's time zone", () => {
  // GitHub stores a due date as midnight UTC; read in a zone west of UTC it must not slip a day.
  expect(milestoneDue("2026-11-20T00:00:00Z", "en-US")).toBe("Due Nov 20, 2026");
  expect(milestoneDue("2026-01-01T00:00:00Z", "en-US")).toBe("Due Jan 1, 2026");
});

test("a milestone without a due date, or with one that isn't a date, says nothing", () => {
  expect(milestoneDue(null, "en-US")).toBeNull();
  expect(milestoneDue("soon", "en-US")).toBeNull();
});

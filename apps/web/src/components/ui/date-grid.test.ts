import { expect, test } from "vitest";
import { addMonths, dateLabel, monthGrid, readDateKey } from "./date-grid.ts";

test("a month's calendar is six Sunday-first weeks with the neighbouring days marked outside", () => {
  const cells = monthGrid("2026-10-15");
  expect(cells).toHaveLength(42);
  // October 2026 starts on a Thursday, so the grid opens on Sunday Sep 27.
  expect(cells[0]).toEqual({ key: "2026-09-27", inMonth: false });
  expect(cells[4]).toEqual({ key: "2026-10-01", inMonth: true });
  expect(cells.filter((cell) => cell.inMonth)).toHaveLength(31);
});

test("moving a month keeps the day, or the month's last day when it has fewer", () => {
  expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
  expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
});

test("a picked date reads as people say it, with the year only when it differs", () => {
  expect(dateLabel("2026-10-21", "2026-10-21")).toBe("Today");
  expect(dateLabel("2026-10-22", "2026-10-21")).toBe("Tomorrow");
  expect(dateLabel("2026-10-30", "2026-10-21")).toBe("Oct 30");
  expect(dateLabel("2027-01-04", "2026-10-21")).toBe("Jan 4, 2027");
});

test("only real calendar dates are read", () => {
  expect(readDateKey("2026-02-30")).toBeUndefined();
  expect(readDateKey("2026-2-3")).toBeUndefined();
  expect(readDateKey("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 });
});

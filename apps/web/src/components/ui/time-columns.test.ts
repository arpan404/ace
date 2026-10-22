import { expect, test } from "vitest";
import { joinTime, splitTime } from "./time-columns.tsx";

test("a time reads as a 12-hour clock and goes back unchanged, noon and midnight included", () => {
  expect(splitTime("19:05")).toEqual({ hour: 7, minute: 5, pm: true });
  expect(splitTime("00:30")).toEqual({ hour: 12, minute: 30, pm: false });
  expect(splitTime("12:00")).toEqual({ hour: 12, minute: 0, pm: true });
  for (const time of ["00:00", "00:30", "11:59", "12:00", "12:01", "19:05", "23:59"])
    expect(joinTime(splitTime(time))).toBe(time);
  expect(joinTime({ ...splitTime("07:05"), pm: true })).toBe("19:05");
});

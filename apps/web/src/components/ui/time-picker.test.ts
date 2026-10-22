import { expect, test } from "vitest";
import { displayTime, readTime } from "./time-picker.tsx";

test("a typed time is read in either clock convention, and nonsense is refused", () => {
  expect(readTime("9:07 pm")).toBe("21:07");
  expect(readTime("9p")).toBe("21:00");
  expect(readTime("12:30 am")).toBe("00:30");
  expect(readTime("21:07")).toBe("21:07");
  expect(readTime("24:00")).toBeUndefined();
  expect(readTime("13 pm")).toBeUndefined();
  expect(readTime("soon")).toBeUndefined();
  expect(displayTime("21:07")).toBe("9:07 PM");
  expect(displayTime("00:30")).toBe("12:30 AM");
});

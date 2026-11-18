import { expect, test } from "vitest";
import { toggled } from "./device-filter-state.ts";

const known = ["mac", "build", "studio"];

test.each([
  ["ticking a device while every device shows narrows to it alone", undefined, "build", ["build"]],
  ["ticking another device adds it", ["build"], "studio", ["build", "studio"]],
  ["unticking one of several keeps the rest", ["build", "studio"], "build", ["studio"]],
  ["unticking the last device shows every device", ["build"], "build", undefined],
  ["ticking the last device missing shows every device", ["build", "studio"], "mac", undefined],
] as const)("%s", (_, scope, device, expected) => {
  expect(toggled(scope, device, known)).toEqual(expected);
});

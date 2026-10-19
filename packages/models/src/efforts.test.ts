import { expect, test } from "vitest";
import { modelEfforts } from "./efforts.ts";

test("the level above High reads XHigh for every provider, whatever it calls it", () => {
  const efforts = modelEfforts([
    "high",
    { id: "extra-high", label: "Extra high" },
    { id: "max", label: "Maximum" },
  ]);
  expect(efforts.map((effort) => effort.label)).toEqual(["High", "XHigh", "Maximum"]);
});

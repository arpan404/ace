import { expect, test } from "vitest";
import { updateArguments } from "./update-arguments.ts";

test.each([
  [["apply"], { command: "apply", drain: false, interrupt: false, outcome: false }],
  [["apply", "--drain"], { drain: true, interrupt: false }],
  [["apply", "--interrupt", "--outcome"], { interrupt: true, outcome: true, drain: false }],
  [["check"], { command: "check" }],
])("ace update %j", (args, expected) => {
  expect(updateArguments(args)).toMatchObject(expected);
});

test.each([
  [["apply", "--drain", "--interrupt"]],
  [["check", "--outcome"]],
  [["apply", "--soon"]],
  [["apply", "--drain", "--drain"]],
])("ace update %j is refused with the usage", (args) => {
  expect(() => updateArguments(args)).toThrow("Usage: ace update");
});

import { expect, test } from "vitest";
import { tabCompletes } from "./path-completion.ts";

test.each([
  ["one folder starts with the letters", "we", ["weather", "mono"], true],
  ["the matches share more than what's typed", "w", ["weather", "website"], true],
  ["the matches share nothing more", "we", ["weather", "website"], false],
  ["no folder starts with the letters", "zz", ["weather", "mono"], false],
  ["an empty folder", "", [], false],
  ["case is ignored", "WE", ["weather"], true],
])("Tab completes when %s: %s", (_, segment, names, expected) => {
  expect(tabCompletes({ segment, names, intoHighlighted: false })).toBe(expected);
});

test("Tab still asks the daemon while the folder is being read", () => {
  expect(tabCompletes({ segment: "we", names: undefined, intoHighlighted: false })).toBe(true);
});

test("Tab goes into the highlighted folder even when nothing completes", () => {
  expect(tabCompletes({ segment: "zz", names: ["mono"], intoHighlighted: true })).toBe(true);
});

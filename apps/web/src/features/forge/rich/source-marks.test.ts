import { expect, test } from "vitest";
import { footnoteNumbers, withTask } from "./source-marks.ts";

test("a tick changes only its own box, in quotes, numbered lists and CRLF text alike", () => {
  const text = "> - [ ] quoted\r\n1. [x] numbered\r\n- [ ] last\r\n";
  expect(withTask(text, 0, true, 3)).toBe("> - [x] quoted\r\n1. [x] numbered\r\n- [ ] last\r\n");
  expect(withTask(text, 1, false, 3)).toBe("> - [ ] quoted\r\n1. [ ] numbered\r\n- [ ] last\r\n");
});

test("boxes that can't be matched to the text with certainty don't tick", () => {
  const text = "- [ ] one\n- [ ] two";
  // The page drew a different number of boxes than the text holds.
  expect(withTask(text, 0, true, 3)).toBeUndefined();
  expect(withTask(text, 5, true, 2)).toBeUndefined();
  // Boxes inside fenced code are text, not tasks.
  expect(withTask("~~~\n- [ ] code\n~~~\n- [ ] real", 0, true, 1)).toBe(
    "~~~\n- [ ] code\n~~~\n- [x] real",
  );
});

test("footnotes are numbered in the order they are defined, outside code", () => {
  expect([...footnoteNumbers("[^b]: two\n```\n[^x]: no\n```\n[^a]: one\n[^b]: again")]).toEqual([
    ["b", 1],
    ["a", 2],
  ]);
});

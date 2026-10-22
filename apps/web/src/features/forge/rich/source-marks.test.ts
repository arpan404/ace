import { Lexer } from "marked";
import { expect, test } from "vitest";
import { footnoteNumbers, taskMarks, withTask } from "./source-marks.ts";

/** Tick the `index`th box the lexer draws (as the page does) and return the new text. */
function tick(source: string, index: number, checked = true) {
  const marks = [...taskMarks(source, new Lexer({ gfm: true, breaks: false }).lex(source))];
  const mark = marks[index]?.[1];
  return { drawn: marks.length, next: mark && withTask(source, mark, checked), label: mark?.label };
}

test("a tick changes only its own box, in quotes, numbered lists and CRLF text alike", () => {
  const text = "> - [ ] quoted\r\n\r\n1. [x] numbered\r\n2. [ ] last\r\n";
  expect(tick(text, 0).next).toBe("> - [x] quoted\r\n\r\n1. [x] numbered\r\n2. [ ] last\r\n");
  expect(tick(text, 1, false).next).toBe(
    "> - [ ] quoted\r\n\r\n1. [ ] numbered\r\n2. [ ] last\r\n",
  );
  expect(tick(text, 2).label).toBe("last");
});

test("the box ticked is the box drawn, even when code and nested lists would miscount", () => {
  // An indented code block holds box-like text; the visible box is in a list nested on one line.
  const text = "    - [ ] b\n\n1. - [ ] a";
  expect(tick(text, 0)).toEqual({ drawn: 1, next: "    - [ ] b\n\n1. - [x] a", label: "a" });
  // Fenced code, an HTML comment and a nested item: only real boxes, each in its own place.
  const mixed = "```\n- [ ] code\n```\n\n<!-- - [ ] note -->\n\n- [ ] one\n  - [ ] two";
  expect(tick(mixed, 1)).toMatchObject({
    drawn: 2,
    next: "```\n- [ ] code\n```\n\n<!-- - [ ] note -->\n\n- [ ] one\n  - [x] two",
  });
});

test("a box is named by its item's words, without markdown marks", () => {
  expect(tick("- [ ] Update **the** [docs](https://x.dev)[^1]\n\n[^1]: n", 0).label).toBe(
    "Update the docs",
  );
});

test("text that no longer holds a box at the drawn place isn't rewritten", () => {
  expect(withTask("- [ ] a", { offset: 1, label: "a" }, true)).toBeUndefined();
});

test("footnotes are numbered in the order they are defined, outside code", () => {
  expect([...footnoteNumbers("[^b]: two\n```\n[^x]: no\n```\n[^a]: one\n[^b]: again")]).toEqual([
    ["b", 1],
    ["a", 2],
  ]);
});

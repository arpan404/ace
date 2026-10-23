import { Lexer, type Token, type Tokens } from "marked";
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

test.each([
  [
    "CRLF text",
    "```\r\n- [ ] a\r\n```\r\n\r\n- [ ] a\r\n",
    "```\r\n- [ ] a\r\n```\r\n\r\n- [x] a\r\n",
  ],
  ["a quote", "> ```\n> - [ ] a\n> ```\n> - [ ] a\n", "> ```\n> - [ ] a\n> ```\n> - [x] a\n"],
  [
    "a list item in CRLF text",
    "1. step\r\n   ```\r\n   - [ ] x\r\n   ```\r\n   - [ ] x\r\n",
    "1. step\r\n   ```\r\n   - [ ] x\r\n   ```\r\n   - [x] x\r\n",
  ],
])("in %s, a box-like line in code is never the one ticked", (_case, text, next) => {
  expect(tick(text, 0)).toMatchObject({ drawn: 1, next });
});

test.each([
  [
    "a blank line between items",
    "- [ ] one\n- [ ] two\n\n- [ ] three\n",
    2,
    "- [ ] one\n- [ ] two\n\n- [x] three\n",
  ],
  [
    "an item with a second paragraph",
    "- [ ] one\n\n  more\n- [ ] two\n",
    1,
    "- [ ] one\n\n  more\n- [x] two\n",
  ],
])("boxes in a loose list (%s) tick too", (_case, text, index, next) => {
  const result = tick(text, index);
  expect(result.next).toBe(next);
  expect(result.drawn).toBe(text.match(/\[ \]/g)?.length);
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

/** The boxes and code blocks a lexer draws from `text`, in order. */
function drawn(text: string) {
  const boxes: boolean[] = [];
  const code: string[] = [];
  const walk = (tokens: readonly Token[]) => {
    for (const token of tokens) {
      if (token.type === "checkbox") boxes.push((token as Tokens.Checkbox).checked);
      if (token.type === "code") code.push(token.raw);
      if (token.type === "list") walk((token as Tokens.List).items);
      if ("tokens" in token && Array.isArray(token.tokens)) walk(token.tokens);
    }
  };
  walk(new Lexer({ gfm: true, breaks: false }).lex(text));
  return { boxes, code };
}

test("across mixed text, a tick flips exactly the box drawn and never touches code", () => {
  const fragments = [
    "- [ ] a",
    "- [x] a",
    "```\n- [ ] a\n```",
    "    - [ ] a",
    "> - [ ] a",
    "> ```\n> - [ ] a\n> ```",
    "1. - [ ] a",
    "- [ ] a\n\n  more",
    "- a\n  - [ ] a",
    "<!-- - [ ] a -->",
    "1. step\n   ```\n   - [ ] a\n   ```\n   - [ ] a",
  ];
  let placed = 0;
  for (const one of fragments)
    for (const two of fragments)
      for (const three of fragments)
        for (const newline of ["\n", "\r\n"]) {
          const text = [one, two, three].join("\n\n").replaceAll("\n", newline) + newline;
          const before = drawn(text);
          const marks = [...taskMarks(text, new Lexer({ gfm: true, breaks: false }).lex(text))];
          for (const [index, [, mark]] of marks.entries()) {
            const next = withTask(text, mark, !before.boxes[index]);
            if (next === undefined) continue;
            placed++;
            const after = drawn(next);
            expect(after.code, text).toEqual(before.code);
            expect(after.boxes, text).toEqual(before.boxes.with(index, !before.boxes[index]));
          }
        }
  // Most boxes are placed (the rest stay read-only, never wrong).
  expect(placed).toBeGreaterThan(2000);
});

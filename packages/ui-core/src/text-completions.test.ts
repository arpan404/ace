import { expect, test } from "vitest";
import { completionAt } from "./text-completions.ts";

/** What the caret completes with `value` typed and the caret at its end. */
const at = (value: string) => completionAt({ value, start: value.length, end: value.length });

test("@ completes a person and # an issue or pull request, from the trigger to the caret", () => {
  expect(at("cc @mi")).toEqual({ kind: "mention", query: "mi", from: 3, to: 6 });
  expect(at("fixes #1")).toEqual({ kind: "reference", query: "1", from: 6, to: 8 });
});

test("code never completes: fences of any kind and indent, indented blocks, and spans", () => {
  for (const value of [
    "```\n~~~\n@mir",
    "````\n```\n@mir",
    "- item\n    ```\n    @mir",
    "para\n\n    @mir",
    "`` a ` @mir",
    "> ```\n> @mir",
    "`@mi",
  ])
    expect(at(value), value).toBeUndefined();
});

test("text that only looks like code still completes", () => {
  // An escaped backtick opens no span, a backslash inside a span doesn't keep it open, a list
  // item's indented line is not code, and a fence line inside indented code is that code's text.
  for (const value of ["\\` @mir", "`a\\` @mir", "- item\n\n    @mir", "para\n\n    ```\n\n@mir"])
    expect(at(value), value).toMatchObject({ kind: "mention", query: "mir" });
});

test("an email address, a heading and a link's #anchor never complete", () => {
  expect(at("mail me@mi")).toBeUndefined();
  expect(at("# Title")).toBeUndefined();
  expect(at("see [setup](#Daemon")).toBeUndefined();
});

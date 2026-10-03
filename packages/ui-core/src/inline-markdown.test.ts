import { expect, test } from "vitest";
import { inlineSpans } from "./inline-markdown.ts";

test("a code identifier in backticks becomes a code span", () => {
  expect(inlineSpans("Should the ack also carry `coldStartWindow`?")).toEqual([
    { kind: "text", text: "Should the ack also carry " },
    { kind: "code", text: "coldStartWindow" },
    { kind: "text", text: "?" },
  ]);
});

test("strong and emphasis are recognised, markers inside code stay literal", () => {
  expect(inlineSpans("**Never** use `a*b*c` _here_")).toEqual([
    { kind: "strong", text: "Never" },
    { kind: "text", text: " use " },
    { kind: "code", text: "a*b*c" },
    { kind: "text", text: " " },
    { kind: "em", text: "here" },
  ]);
});

test("unmatched markers and snake_case stay plain text", () => {
  expect(inlineSpans("5 * 3 and max_buffered_size, `open")).toEqual([
    { kind: "text", text: "5 * 3 and max_buffered_size, `open" },
  ]);
});

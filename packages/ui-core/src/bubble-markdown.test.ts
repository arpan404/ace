import { expect, test } from "vitest";
import { looksLikeMarkdown, withHardBreaks } from "./bubble-markdown.ts";

test.each([
  ["a heading", "# Plan\nShip it"],
  ["a list", "Steps:\n- build\n- test"],
  ["a numbered list", "1. build\n2. test"],
  ["a fenced block", "Run:\n```sh\nbun run check\n```"],
  ["a table", "| a | b |\n| --- | --- |\n| 1 | 2 |"],
  ["a quote", "> as they said"],
  ["a link", "See [the docs](https://acehq.dev/docs)."],
  ["inline code", "Call `thread_start` first."],
  ["bold words", "This is **important** now."],
  ["italic words", "This is *really* it."],
])("%s renders as markdown", (_, text) => {
  expect(looksLikeMarkdown(text)).toBe(true);
});

test.each([
  ["plain lines", "Hello there\nhow are you?"],
  ["a hash in prose", "Fix issue #12 please"],
  ["one dash line", "- just one thought"],
  ["arithmetic", "2 * 3 * 4 = 24"],
  ["snake_case", "rename my_var_name to other_name"],
  ["a bare URL", "https://example.com/a/very/long/path"],
  ["a lone star", "rated 5* by users"],
])("%s stays plain text", (_, text) => {
  expect(looksLikeMarkdown(text)).toBe(false);
});

test("line breaks inside a paragraph are kept, and fenced code is left alone", () => {
  expect(withHardBreaks("one\ntwo\n\nthree")).toBe("one  \ntwo\n\nthree");
  expect(withHardBreaks("```\na\nb\n```")).toBe("```\na\nb\n```");
});

import { expect, test } from "vitest";
import { selectionQuote } from "./block-quote.ts";

test.each([
  ["one line", "renders its own panel", "> renders its own panel\n\n"],
  ["lines keep their breaks", "first line\nsecond line", "> first line\n> second line\n\n"],
  ["paragraphs keep one blank quoted line", "one\n\n\n\ntwo", "> one\n>\n> two\n\n"],
  ["edges and trailing spaces trimmed", "  \n hello  \r\nworld \n", "> hello\n> world\n\n"],
])("a selection quotes as Markdown: %s", (_, selected, quote) => {
  expect(selectionQuote(selected)).toBe(quote);
});

test("a selection of only blank space quotes nothing", () => {
  expect(selectionQuote(" \n\t\n")).toBeUndefined();
});

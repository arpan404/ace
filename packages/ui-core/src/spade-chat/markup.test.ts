import { expect, test } from "vitest";
import { spadeMarkup, spadePlainText } from "./index.ts";

test("a bubble reads paragraphs, lists and code blocks, with bold, code and links in a line", () => {
  const blocks = spadeMarkup(
    [
      "Here's a first pass:",
      "- **Flights**: TAP `TP1351` on the 14th",
      "- Hotels near Chiado",
      "",
      "```",
      "09:11  Rossio → Sintra",
      "```",
      "1. Pack",
      "2. Go",
      "The plan is in [lisbon-trip.md](https://example.com/trip), or https://example.com/b.",
    ].join("\n"),
  );
  expect(blocks).toEqual([
    { kind: "paragraph", inlines: [{ kind: "text", text: "Here's a first pass:" }] },
    {
      kind: "list",
      ordered: false,
      items: [
        [
          { kind: "bold", text: "Flights" },
          { kind: "text", text: ": TAP " },
          { kind: "code", text: "TP1351" },
          { kind: "text", text: " on the 14th" },
        ],
        [{ kind: "text", text: "Hotels near Chiado" }],
      ],
    },
    { kind: "code", text: "09:11  Rossio → Sintra", language: undefined },
    {
      kind: "list",
      ordered: true,
      items: [[{ kind: "text", text: "Pack" }], [{ kind: "text", text: "Go" }]],
    },
    {
      kind: "paragraph",
      inlines: [
        { kind: "text", text: "The plan is in " },
        { kind: "link", text: "lisbon-trip.md", href: "https://example.com/trip" },
        { kind: "text", text: ", or " },
        { kind: "link", text: "https://example.com/b", href: "https://example.com/b" },
        { kind: "text", text: "." },
      ],
    },
  ]);
});

test("no mark shows as written: headings, quotes, rules, tables, italics and pictures read as what they mean", () => {
  const blocks = spadeMarkup(
    [
      "## Morning brief ##",
      "> Rain → Wet ← Sprinkler",
      "> stays one quote",
      "---",
      "| PR | State |",
      "| --- | :-: |",
      "| #2081 | *fails* on Linux |",
      "- [x] ~~old~~ done",
      "![chart](https://example.com/c.png) and snake_case_name stay",
      "```ts",
      "await clock.advance(5000);",
      "```",
    ].join("\n"),
  );
  expect(blocks).toEqual([
    { kind: "heading", inlines: [{ kind: "text", text: "Morning brief" }] },
    { kind: "quote", inlines: [{ kind: "text", text: "Rain → Wet ← Sprinkler\nstays one quote" }] },
    {
      kind: "table",
      head: [[{ kind: "text", text: "PR" }], [{ kind: "text", text: "State" }]],
      rows: [
        [
          [{ kind: "text", text: "#2081" }],
          [
            { kind: "italic", text: "fails" },
            { kind: "text", text: " on Linux" },
          ],
        ],
      ],
    },
    {
      kind: "list",
      ordered: false,
      items: [
        [
          { kind: "strike", text: "old" },
          { kind: "text", text: " done" },
        ],
      ],
    },
    {
      kind: "paragraph",
      inlines: [
        { kind: "link", text: "chart", href: "https://example.com/c.png" },
        { kind: "text", text: " and snake_case_name stay" },
      ],
    },
    { kind: "code", text: "await clock.advance(5000);", language: "ts" },
  ]);
});

test("a code block still being written runs to the end of the message", () => {
  expect(spadeMarkup("Here:\n```py\nprint(1)")).toEqual([
    { kind: "paragraph", inlines: [{ kind: "text", text: "Here:" }] },
    { kind: "code", text: "print(1)", language: "py" },
  ]);
});

test("a link must be http(s); anything else stays the text it is", () => {
  expect(spadeMarkup("[x](javascript:alert(1)) costs 2 * 3")).toEqual([
    {
      kind: "paragraph",
      inlines: [{ kind: "text", text: "[x](javascript:alert(1)) costs 2 * 3" }],
    },
  ]);
});

test("plain text, for Copy, keeps the words and drops the marks", () => {
  expect(
    spadePlainText(
      "## Two PRs\n- **#2081** fails\n- [#2079](https://x.dev/2079)\n\n| a | b |\n|---|---|\n| 1 | 2 |",
    ),
  ).toBe("Two PRs\n\n- #2081 fails\n- #2079\n\na\tb\n1\t2");
});

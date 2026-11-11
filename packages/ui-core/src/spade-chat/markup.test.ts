import { expect, test } from "vitest";
import { spadeMarkup } from "./index.ts";

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
    { kind: "code", text: "09:11  Rossio → Sintra" },
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

test("anything else stays the text it is, line breaks kept, and a link must be http(s)", () => {
  expect(spadeMarkup("# Not a heading\n[x](javascript:alert(1))\n> quote")).toEqual([
    {
      kind: "paragraph",
      inlines: [{ kind: "text", text: "# Not a heading\n[x](javascript:alert(1))\n> quote" }],
    },
  ]);
});

import { expect, test } from "vitest";
import { previewKeep, previewLead, previewParts } from "./content-search-preview.ts";

/** Parts written as text with each match in [brackets]. */
function shown(preview: string, ranges: [number, number][], cutBefore = false): string {
  return previewParts(preview, ranges, cutBefore)
    .map((part) => (part.match ? `[${part.text}]` : part.text))
    .join("");
}

const at = (text: string, word: string, from = 0): [number, number] => {
  const start = text.indexOf(word, from);
  return [start, start + word.length];
};

const long = `${"x".repeat(300)} arpan ${"y".repeat(300)}`;
const markdown = "Never copy, paste or closely paraphrase code from t3code or arpan404/ace-legacy";
const link = "See [#72](https://github.com/arpan404/ace/pull/72) for the earlier attempt";
const emoji = "😀😀😀😀😀😀😀😀 quokka";

type Case = [
  name: string,
  preview: string,
  ranges: [number, number][],
  shown: string,
  cutBefore?: boolean,
];

test.each<Case>([
  [
    "a match at the start keeps the line from its start",
    "arpan was here",
    [at("arpan was here", "arpan")],
    "[arpan] was here",
  ],
  [
    "indentation before a match goes, without an ellipsis",
    "    return arpan;",
    [at("    return arpan;", "arpan")],
    "return [arpan];",
  ],
  [
    "a match far into a line keeps only a little context before it",
    markdown,
    [at(markdown, "arpan")],
    "…m t3code or [arpan]404/ace-legacy",
  ],
  [
    "a match inside a link shows the match, not the link's start",
    link,
    [at(link, "arpan")],
    "…/github.com/[arpan]404/ace/pull/72) for the earlier attempt",
  ],
  [
    "a match at the end of a line still shows",
    "the last word is arpan",
    [at("the last word is arpan", "arpan")],
    "…ast word is [arpan]",
  ],
  [
    "every match on a line is marked",
    "arpan and arpan again",
    [at("arpan and arpan again", "arpan"), at("arpan and arpan again", "arpan", 1)],
    "[arpan] and [arpan] again",
  ],
  [
    "overlapping ranges mark one run",
    "quokkas",
    [
      [0, 5],
      [3, 7],
    ],
    "[quokkas]",
  ],
  [
    "ranges past the preview are ignored",
    "short",
    [
      [2, 4],
      [40, 50],
    ],
    "sh[or]t",
  ],
  [
    "a preview the daemon already cut opens with an ellipsis",
    "arpan rest",
    [[0, 5]],
    "…[arpan] rest",
    true,
  ],
])("%s", (_name, preview, ranges, expected, cutBefore = false) => {
  expect(shown(preview, ranges, cutBefore)).toBe(expected);
});

test("a very long line keeps the match and a bounded tail, with an ellipsis at both cuts", () => {
  const text = shown(long, [at(long, "arpan")]);
  expect(text.startsWith(`…${"x".repeat(previewLead - 1)} [arpan] y`)).toBe(true);
  expect(text.endsWith("y…")).toBe(true);
  expect(text.length).toBeLessThanOrEqual(previewKeep + 4);
});

test("wide characters before a match are never split in half", () => {
  const range = at(emoji, "quokka");
  const parts = previewParts(emoji, [range]);
  const before = parts[0]?.text ?? "";
  expect(before.startsWith("…")).toBe(true);
  // Each 😀 is two UTF-16 code units: the kept context holds whole ones only.
  expect([...before.slice(1).trimEnd()].every((char) => char === "😀")).toBe(true);
  expect(parts.find((part) => part.match)?.text).toBe("quokka");
});

test("a match longer than what is kept still shows whole", () => {
  const huge = "z".repeat(previewKeep + 50);
  expect(previewParts(huge, [[0, huge.length]])).toEqual([{ text: huge, match: true, at: 0 }]);
});

import { expect, it, vi } from "vitest";
import {
  CODE_VISIBLE_LINES,
  codeLineCount,
  isCodeCollapsible,
  markdownBlocks,
  markdownInline,
  markdownPieces,
  visibleCodeText,
} from "./markdown.ts";
import { copyCodeText } from "./clipboard.ts";

it("parses prose, lists, a closed fence, a quote, a rule and an ordered list", () => {
  const text = [
    "## Result",
    "Orphan cleanup now records the **start time**",
    "and owner.",
    "",
    "- `ace stop` interrupts the tree",
    "- `ace stop --all` keeps to our processes",
    "  started by ace",
    "",
    "```ts",
    "if (owner.startedAt !== kernel.startedAt) return;",
    "```",
    "> Never kill a reused PID.",
    "",
    "---",
    "3. Third",
    "4. Fourth",
  ].join("\n");
  expect(markdownBlocks(text)).toEqual([
    { kind: "heading", level: 2, text: "Result" },
    { kind: "paragraph", text: "Orphan cleanup now records the **start time**\nand owner." },
    {
      kind: "list",
      ordered: false,
      start: 1,
      items: [
        "`ace stop` interrupts the tree",
        "`ace stop --all` keeps to our processes\nstarted by ace",
      ],
    },
    { kind: "code", language: "ts", text: "if (owner.startedAt !== kernel.startedAt) return;" },
    { kind: "quote", text: "Never kill a reused PID." },
    { kind: "rule" },
    { kind: "list", ordered: true, start: 3, items: ["Third", "Fourth"] },
  ]);
});

it("keeps a fence still streaming as code until it closes", () => {
  expect(markdownBlocks("Run this:\n```sh\nbun run test\n# heading-looking line")).toEqual([
    { kind: "paragraph", text: "Run this:" },
    { kind: "code", language: "sh", text: "bun run test\n# heading-looking line" },
  ]);
  expect(markdownBlocks("````\n```\nnested\n````\nafter")).toEqual([
    { kind: "code", language: "", text: "```\nnested" },
    { kind: "paragraph", text: "after" },
  ]);
});

it("leaves hashes without a space and lone dashes as prose", () => {
  expect(markdownBlocks("#hashtag\n-not a list")).toEqual([
    { kind: "paragraph", text: "#hashtag\n-not a list" },
  ]);
});

it("keeps table cell boundaries around pipes and reads following prose", () => {
  expect(
    markdownBlocks(
      "Before\n\n| Area | Result |\n| --- | :---: |\n| UI | **Fixed** |\n| Code | `a|b` and a\\|b |\n\nAfter",
    ),
  ).toEqual([
    { kind: "paragraph", text: "Before" },
    {
      kind: "table",
      headers: ["Area", "Result"],
      rows: [
        ["UI", "**Fixed**"],
        ["Code", "`a|b` and a|b"],
      ],
    },
    { kind: "paragraph", text: "After" },
  ]);
  expect(markdownBlocks("```\n| Raw | Table |\n| --- | --- |\n```")).toEqual([
    { kind: "code", language: "", text: "| Raw | Table |\n| --- | --- |" },
  ]);
});

it("leaves malformed markdown readable instead of dropping it", () => {
  expect(markdownBlocks("```unclosed\nstill here")).toEqual([
    { kind: "code", language: "unclosed", text: "still here" },
  ]);
  expect(markdownBlocks("| lone | pipes |\nno separator row")).toEqual([
    { kind: "paragraph", text: "| lone | pipes |\nno separator row" },
  ]);
  expect(markdownInline("**unclosed bold and `open code")).toEqual([
    { kind: "text", text: "**unclosed bold and `open code" },
  ]);
});

it("parses inline emphasis, code spans and allowlisted links", () => {
  expect(markdownInline("Run **bold** and *soft* `code`")).toEqual([
    { kind: "text", text: "Run " },
    { kind: "strong", text: "bold" },
    { kind: "text", text: " and " },
    { kind: "emphasis", text: "soft" },
    { kind: "text", text: " " },
    { kind: "code", text: "code" },
  ]);
  expect(markdownInline("[docs](https://example.com) and [evil](javascript:alert(1))")).toEqual([
    { kind: "link", text: "docs", url: "https://example.com" },
    { kind: "text", text: " and [evil](javascript:alert(1))" },
  ]);
});

it("only changes the last piece when a long paragraph streams", () => {
  const sentence = "Next step: wire the safe kill-all filters. ";
  const text = sentence.repeat(120);
  const before = markdownPieces(text, 400);
  const after = markdownPieces(`${text}More`, 400);
  expect(before.length).toBeGreaterThan(2);
  expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
  expect(after[after.length - 1]?.endsWith("More")).toBe(true);
  expect(after.join(" ")).toBe(`${text}More`);
});

it("keeps a short paragraph whole", () => {
  expect(markdownPieces("One sentence. Two sentences.")).toEqual(["One sentence. Two sentences."]);
  expect(markdownPieces("")).toEqual([""]);
});

it("collapses a long code block to its first lines until expanded", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  expect(codeLineCount(lines)).toBe(30);
  expect(isCodeCollapsible(lines)).toBe(true);
  expect(visibleCodeText(lines, false).split("\n")).toHaveLength(CODE_VISIBLE_LINES);
  expect(visibleCodeText(lines, true)).toBe(lines);
  const barely = Array.from({ length: CODE_VISIBLE_LINES + 1 }, (_, i) => `l${i}`).join("\n");
  expect(isCodeCollapsible(barely)).toBe(false);
  expect(visibleCodeText(barely, false)).toBe(barely);
});

it("copies code through the native bridge and reports bridge failure", () => {
  const copyText = vi.fn().mockReturnValue(true);
  expect(copyCodeText("echo hi", () => ({ copyText }))).toBe(true);
  expect(copyText).toHaveBeenCalledWith("echo hi");
  expect(copyCodeText("echo hi", () => ({ copyText: () => false }))).toBe(false);
  expect(
    copyCodeText("echo hi", () => {
      throw new Error("no bridge");
    }),
  ).toBe(false);
});

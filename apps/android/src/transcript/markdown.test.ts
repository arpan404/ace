import { expect, it, vi } from "vitest";
import {
  CODE_VISIBLE_LINES,
  INLINE_MESSAGE_LIMIT,
  LONG_MESSAGE_PREVIEW_CHARS,
  STREAMING_FULL_PARSE_CHARS,
  STREAMING_HEAD_GROWTH_CHARS,
  STREAMING_TAIL_CHARS,
  accumulateStreamingBlocks,
  blockFingerprint,
  codeLineCount,
  fingerprintText,
  isCodeCollapsible,
  isInOpenFence,
  isOverInlineLimit,
  isSafeWebUrl,
  longMessagePreview,
  markdownBlocks,
  markdownInline,
  markdownPieces,
  streamingSplit,
  visibleCodeText,
  withStableKeys,
  type StreamingAccumulator,
} from "./markdown.ts";
import { openWebLink } from "./links.ts";
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

it("parses inline emphasis, code spans and safe web links only", () => {
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
  // ace:// stays literal: Android has no in-message file opener, and the
  // Files screen remains the only file route.
  expect(markdownInline("[file](ace://thread/file)")).toEqual([
    { kind: "text", text: "[file](ace://thread/file)" },
  ]);
  expect(markdownInline("[spaced](https://example.com/a b)")).toEqual([
    { kind: "text", text: "[spaced](https://example.com/a b)" },
  ]);
});

it("validates web URLs before styling them as links", () => {
  expect(isSafeWebUrl("https://example.com/a?b=c")).toBe(true);
  expect(isSafeWebUrl("http://example.com/")).toBe(true);
  expect(isSafeWebUrl("ace://thread/file")).toBe(false);
  expect(isSafeWebUrl("javascript:alert(1)")).toBe(false);
  expect(isSafeWebUrl("https://example.com/a b")).toBe(false);
  expect(isSafeWebUrl("https://example.com/a\nb")).toBe(false);
  expect(isSafeWebUrl(`https://example.com/${"a".repeat(2048)}`)).toBe(false);
  expect(isSafeWebUrl("")).toBe(false);
});

it("only changes the last piece when a long paragraph streams", () => {
  const sentence = "Next step: wire the safe kill-all filters. ";
  const text = sentence.repeat(120);
  const before = markdownPieces(text, 400);
  const after = markdownPieces(`${text}More`, 400);
  expect(before.length).toBeGreaterThan(2);
  expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
  expect(after[after.length - 1]?.endsWith("More")).toBe(true);
  expect(after.join("")).toBe(`${text}More`);
  expect(before.join("")).toBe(text);
});

it("keeps sentence spaces inside flowing pieces", () => {
  const pieces = markdownPieces("End. Next.", 4);
  expect(pieces.join("")).toBe("End. Next.");
  expect(pieces.length).toBeGreaterThan(1);
  expect(pieces[1]?.startsWith(" ")).toBe(true);
});

it("splits long paragraphs at the production size", () => {
  const sentence = "Streaming sentence with enough words to pass the bound. ";
  const text = sentence.repeat(80);
  expect(text.length).toBeGreaterThan(2_000);
  const pieces = markdownPieces(text);
  expect(pieces.length).toBeGreaterThan(1);
  expect(pieces.join("")).toBe(text);
  for (const piece of pieces.slice(0, -1)) {
    expect(piece.length).toBeGreaterThanOrEqual(2_000);
  }
});

it("bounds over-limit messages instead of parsing them", () => {
  expect(isOverInlineLimit("a".repeat(INLINE_MESSAGE_LIMIT))).toBe(false);
  expect(isOverInlineLimit("a".repeat(INLINE_MESSAGE_LIMIT + 1))).toBe(true);
  const long = "b".repeat(INLINE_MESSAGE_LIMIT + 10);
  const preview = longMessagePreview(long);
  expect(preview.length).toBe(LONG_MESSAGE_PREVIEW_CHARS);
  expect(long.startsWith(preview)).toBe(true);
});

it("opens only safe web links and never throws", async () => {
  const opened: string[] = [];
  expect(
    await openWebLink("https://example.com/a", { openURL: (url) => void opened.push(url) }),
  ).toBe(true);
  expect(opened).toEqual(["https://example.com/a"]);
  expect(await openWebLink("ace://thread/file", { openURL: () => true })).toBe(false);
  expect(await openWebLink("javascript:alert(1)", { openURL: () => true })).toBe(false);
  expect(
    await openWebLink("https://example.com/", {
      openURL: () => {
        throw new Error("no browser");
      },
    }),
  ).toBe(false);
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

it("fingerprints the full string so a tail-only change keeps its identity", () => {
  const head = "Statement of work for the transcript row. ".repeat(2);
  expect(head.length).toBeGreaterThan(64);
  const before = `${head}Draft one.`;
  const after = `${head}Draft two!`;
  expect(before.length).toBe(after.length);
  expect(before.slice(0, 64)).toBe(after.slice(0, 64));
  // A 64-char window would hash these identically and reuse stale rows.
  expect(fingerprintText(before)).not.toBe(fingerprintText(after));
  expect(fingerprintText(before)).toBe(fingerprintText(before));
  expect(fingerprintText("")).toBe(fingerprintText(""));
});

it("keeps settled block keys stable across a streaming delta", () => {
  const before = "First paragraph stays.\n\nSecond paragraph grows.";
  const after = "First paragraph stays.\n\nSecond paragraph grows further.";
  const beforeKeys = withStableKeys(markdownBlocks(before), blockFingerprint).map(
    (keyed) => keyed.key,
  );
  const afterKeys = withStableKeys(markdownBlocks(after), blockFingerprint).map(
    (keyed) => keyed.key,
  );
  expect(beforeKeys).toHaveLength(2);
  expect(afterKeys).toHaveLength(2);
  expect(afterKeys[0]).toBe(beforeKeys[0]);
  expect(afterKeys[1]).not.toBe(beforeKeys[1]);
});

it("keeps duplicate blocks unique with occurrence counting", () => {
  const keys = withStableKeys(markdownBlocks("Same.\n\nSame."), blockFingerprint).map(
    (keyed) => keyed.key,
  );
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(2);
  expect(keys[1]).toContain("#2");
});

function largeDoc(paragraphs: number): string {
  const section = [
    "## Progress update",
    "",
    "Shipping the transcript row with **bold** claims and `code` samples.",
    "",
    "- first item with a [safe link](https://example.com/a)",
    "- second item",
    "",
    "```ts",
    "const settled = true;",
    "```",
    "",
    "| Area | Result |",
    "| --- | --- |",
    "| UI | Fixed |",
    "",
    "> Quoted context stays readable.",
    "",
    "---",
    "",
  ].join("\n");
  return Array.from(
    { length: paragraphs },
    (_, i) => `Paragraph ${i + 1} streams in.\n\n${section}`,
  )
    .join("\n")
    .concat("\n");
}

it("splits large streaming text at a blank line so head plus tail rejoin exactly", () => {
  expect(streamingSplit("small\n\ntext")).toBeNull();
  const doc = largeDoc(60);
  expect(doc.length).toBeGreaterThan(STREAMING_FULL_PARSE_CHARS);
  const split = streamingSplit(doc);
  expect(split).not.toBeNull();
  const { head, tail } = split!;
  expect(head + tail).toBe(doc);
  expect(head.endsWith("\n\n")).toBe(true);
  expect(tail.length).toBeLessThanOrEqual(STREAMING_TAIL_CHARS + 500);
  expect([...markdownBlocks(head), ...markdownBlocks(tail)]).toEqual(markdownBlocks(doc));
});

it("falls back to a full parse when a split would be unsafe", () => {
  expect(streamingSplit("word ".repeat(5000))).toBeNull();
  const openFence = `\`\`\`sh\n${"echo hi\n\n".repeat(2500)}still streaming`;
  expect(openFence.length).toBeGreaterThan(STREAMING_FULL_PARSE_CHARS);
  expect(isInOpenFence(openFence)).toBe(true);
  expect(streamingSplit(openFence)).toBeNull();
  expect(isInOpenFence("```sh\necho hi\n```\n\nAfter")).toBe(false);
});

it("never mistakes a table row starting with a code span for a fence", () => {
  expect(isInOpenFence("| H1 | H2 |\n| --- | --- |\n```x``` | v |\n")).toBe(false);
  expect(isInOpenFence("| H1 | H2 |\n| --- | --- |\n```x``` | v |\n~~~\ncode\n")).toBe(true);
  expect(markdownBlocks("| H1 | H2 |\n| --- | --- |\n```x``` | v |\n")).toEqual([
    { kind: "table", headers: ["H1", "H2"], rows: [["```x```", "v"]] },
  ]);
});

function paddedDoc(middle: string, tail: string): string {
  const filler = "Padding filler sentence to grow the document past the split threshold. ";
  let pad = "";
  while (pad.length <= STREAMING_FULL_PARSE_CHARS) pad += `${filler.repeat(30)}\n\n`;
  return `${pad}${middle}\n\n${tail}`;
}

it("falls back to the full parse when a table row hides an open fence", () => {
  const middle = [
    "| H1 | H2 |",
    "| --- | --- |",
    "```x``` | v |",
    "~~~",
    "streaming code",
    "```",
  ].join("\n");
  const full = paddedDoc(middle, "end ".repeat(2500));
  expect(full.length).toBeGreaterThan(STREAMING_FULL_PARSE_CHARS);
  // The ``` line is a table row, so the ~~~ fence is really still open and
  // the blank-line cut would sit inside code: no safe split exists.
  expect(streamingSplit(full)).toBeNull();
  const first = accumulateStreamingBlocks({ head: "", blocks: [] }, full);
  expect(first.blocks).toEqual(markdownBlocks(full));
  const second = accumulateStreamingBlocks(first.state, `${full}more.\n`);
  expect(second.blocks).toEqual(markdownBlocks(`${full}more.\n`));
});

it("falls back to the full parse when blank lines are too sparse to bound the tail", () => {
  const sparse = `${"A".repeat(STREAMING_FULL_PARSE_CHARS + 1000)}\n\n${"b ".repeat(20000)}`;
  expect(sparse.length).toBeGreaterThan(STREAMING_FULL_PARSE_CHARS);
  // The only blank-line boundary leaves a ~40k tail: unbounded, so no split.
  expect(streamingSplit(sparse)).toBeNull();
  expect(accumulateStreamingBlocks({ head: "", blocks: [] }, sparse).blocks).toEqual(
    markdownBlocks(sparse),
  );
});

it("keeps accepted split tails bounded", () => {
  const doc = largeDoc(60);
  const split = streamingSplit(doc);
  expect(split).not.toBeNull();
  expect(split!.tail.length).toBeLessThanOrEqual(
    STREAMING_TAIL_CHARS + STREAMING_HEAD_GROWTH_CHARS,
  );
});

it("keeps incremental blocks exact across streaming deltas", () => {
  const section = [
    "| H1 | H2 |",
    "| --- | --- |",
    "| a | b |",
    "",
    "```ts",
    "const streaming = true;",
    "```",
    "",
    "> Quoted context stays readable.",
    "",
    "- item one",
    "- item two",
    "",
  ].join("\n");
  let text = "";
  let state: StreamingAccumulator = { head: "", blocks: [] };
  let accepted = 0;
  for (let i = 1; i <= 120; i++) {
    text += `Paragraph ${i} streams in.\n\n${section}\n`;
    const result = accumulateStreamingBlocks(state, text);
    expect(result.blocks).toEqual(markdownBlocks(text));
    if (result.state.head !== "") accepted += 1;
    state = result.state;
  }
  expect(text.length).toBeGreaterThan(STREAMING_FULL_PARSE_CHARS);
  expect(accepted).toBeGreaterThan(0);
  // A delta that opens a fence mid-stream stays exact, then closing it does too.
  const open = `${text}\n\`\`\`sh\nstill open\n`;
  expect(accumulateStreamingBlocks(state, open).blocks).toEqual(markdownBlocks(open));
  const closed = `${open}\`\`\`\n\ndone\n`;
  expect(accumulateStreamingBlocks(state, closed).blocks).toEqual(markdownBlocks(closed));
});

it("accumulates streaming deltas with a stable head and exact blocks", () => {
  const first = largeDoc(60);
  const second = `${first}Tail sentence one more.\n\nTail sentence two more.\n`;
  let state: StreamingAccumulator = { head: "", blocks: [] };
  const one = accumulateStreamingBlocks(state, first);
  expect(one.blocks).toEqual(markdownBlocks(first));
  expect(one.state.head).not.toBe("");
  const two = accumulateStreamingBlocks(one.state, second);
  expect(two.blocks).toEqual(markdownBlocks(second));
  // A small delta does not reparse the settled head: same block references.
  expect(two.state.blocks).toBe(one.state.blocks);
  // Once the head grows by a full chunk it advances and still rejoins exactly.
  const third = `${second}${"Another streamed line.\n\n".repeat(400)}`;
  expect(third.length - second.length).toBeGreaterThan(STREAMING_HEAD_GROWTH_CHARS);
  const three = accumulateStreamingBlocks(two.state, third);
  expect(three.blocks).toEqual(markdownBlocks(third));
  expect(three.state.head.length).toBeGreaterThan(two.state.head.length);
});

it("resets the settled head when streaming text is edited, not appended", () => {
  const first = largeDoc(60);
  const one = accumulateStreamingBlocks({ head: "", blocks: [] }, first);
  const edited = `Revised opener.\n\n${first.slice(first.indexOf("\n\n") + 2)}`;
  const two = accumulateStreamingBlocks(one.state, edited);
  expect(two.blocks).toEqual(markdownBlocks(edited));
});

it("keeps the over-limit preview on character boundaries", () => {
  const emoji = "😀";
  const long = `${"a".repeat(LONG_MESSAGE_PREVIEW_CHARS - 1)}${emoji}${"b".repeat(INLINE_MESSAGE_LIMIT)}`;
  const preview = longMessagePreview(long);
  expect(long.startsWith(preview)).toBe(true);
  expect(preview).toBe("a".repeat(LONG_MESSAGE_PREVIEW_CHARS - 1));
  // eslint-disable-next-line no-control-regex
  expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(preview)).toBe(false);
  expect(preview.length).toBeLessThanOrEqual(LONG_MESSAGE_PREVIEW_CHARS);
});

it("keeps the over-limit preview literal instead of parsed", () => {
  const tricky = "**bold** [x](javascript:alert(1))\n```unclosed\n";
  const preview = longMessagePreview(`${tricky}${"z".repeat(INLINE_MESSAGE_LIMIT)}`);
  expect(preview.startsWith(tricky)).toBe(true);
  expect(preview).toContain("**bold**");
});

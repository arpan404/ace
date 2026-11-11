import { describe, expect, test } from "vitest";
import { boldAt, breakLine, clearLineStyle, typeStyled } from "./composer-block-edits.ts";
import type { ComposerEdited } from "./composer-block-edits.ts";

/** `|` marks the caret; two of them mark a selection. */
function parse(marked: string) {
  const start = marked.indexOf("|");
  const second = marked.indexOf("|", start + 1);
  const text = marked.replaceAll("|", "");
  return { text, selection: { start, end: second === -1 ? start : second - 1 } };
}
const show = (edited: ComposerEdited | undefined) =>
  edited && `${edited.text.slice(0, edited.caret)}|${edited.text.slice(edited.caret)}`;

describe("the newline key", () => {
  test.each([
    ["breaks plain words", "ab|cd", "ab\n|cd"],
    ["keeps bold words bold on both lines, no marks left showing", "**ab|cd**", "**ab**\n**|cd**"],
    ["at the end of bold words starts a plain line", "**ab|**", "**ab**\n|"],
    ["after a heading starts plain words", "# Plan|", "# Plan\n|"],
    ["continues a bullet", "- milk|", "- milk\n- |"],
    ["continues a numbered list and counts on", "1. a|\n2. b", "1. a\n2. |\n3. b"],
    ["splits a bold item", "- **ab|cd**", "- **ab**\n- **|cd**"],
    ["ends a list on an empty item", "- a\n- |", "- a\n|"],
    ["steps an empty nested item out", "- a\n  - |", "- a\n- |"],
    ["takes out the selected words first", "a|bc|d", "a\n|d"],
    ["takes out a selection across bold edges cleanly", "**a|b** c|d", "**a**\n|d"],
  ])("%s", (_name, before, after) => {
    const { text, selection } = parse(before);
    expect(show(breakLine(text, [], selection))).toBe(after);
  });
});

describe("Backspace at the start of a line's words", () => {
  test.each([
    ["turns a heading back into plain words", "## Plan", 0, "|Plan"],
    ["takes a bullet off a top-level item", "- milk", 0, "|milk"],
    ["steps a nested item out a level first", "- a\n  - b", 1, "- a\n- |b"],
    ["keeps bold words bold", "# **Big**", 0, "**|Big**"],
  ])("%s", (_name, text, line, after) => {
    expect(show(clearLineStyle(text, [], line))).toBe(after);
  });

  test("is left to the browser on a plain line", () => {
    expect(clearLineStyle("a\nb", [], 1)).toBeUndefined();
  });
});

describe("typing bold or plain at a bare caret", () => {
  test.each([
    ["bold where words are plain", "say |", "x", true, "say **x|**"],
    ["bold right after bold words joins them", "**ab**|", "x", true, "**abx|**"],
    ["bold right before bold words joins them", "|**ab**", "x", true, "**x|ab**"],
    ["plain at the end of bold words goes after them", "**ab|**", "x", false, "**ab**x|"],
    ["plain at the start of bold words goes before them", "**|ab**", "x", false, "x|**ab**"],
    ["plain inside bold words splits them", "**a|b**", "x", false, "**a**x|**b**"],
    ["a space typed bold waits for words, never writing empty marks", "say |", " ", true, "say  |"],
  ])("%s", (_name, before, typed, bold, after) => {
    const { text, selection } = parse(before);
    expect(show(typeStyled(text, [], selection.start, typed, bold))).toBe(after);
  });

  test.each([
    ["inside bold words", "**a|b**", true],
    ["at the end of bold words", "**ab|**", true],
    ["after their closing marks", "**ab**| c", false],
    ["in plain words", "a|b", false],
  ])("what is typed %s is bold: %s", (_name, before, bold) => {
    const { text, selection } = parse(before);
    expect(boldAt(text, [], selection.start)).toBe(bold);
  });
});

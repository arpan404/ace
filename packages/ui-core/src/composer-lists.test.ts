import { describe, expect, test } from "vitest";
import { continueList, indentList, renumberEdits } from "./composer-lists.ts";
import { applyTextChange, applyTextEdits, type TextChange } from "./composer-text-edits.ts";

/** `|` marks the caret; two of them mark a selection. */
function parse(marked: string) {
  const start = marked.indexOf("|");
  const end = marked.indexOf("|", start + 1);
  const text = marked.replaceAll("|", "");
  return { text, selection: { start, end: end === -1 ? start : end - 1 } };
}
function show(text: string, change: TextChange | undefined): string | undefined {
  if (!change) return undefined;
  const after = applyTextChange(text, [], change);
  const { start, end } = after.selection;
  return start === end
    ? after.text.slice(0, start) + "|" + after.text.slice(start)
    : after.text.slice(0, start) + "|" + after.text.slice(start, end) + "|" + after.text.slice(end);
}

describe("the newline key in a list", () => {
  test.each([
    ["continues a bullet", "- milk|", "- milk\n- |"],
    ["keeps the bullet's own mark", "* milk|", "* milk\n* |"],
    ["counts up a numbered item", "1. milk|", "1. milk\n2. |"],
    ["keeps the delimiter", "1) milk|", "1) milk\n2) |"],
    ["keeps a nested item's indent", "- a\n  - b|", "- a\n  - b\n  - |"],
    ["splits an item at the caret", "- milk| and eggs", "- milk\n- | and eggs"],
    ["renumbers the items after it", "1. a|\n2. b\n3. c", "1. a\n2. |\n3. b\n4. c"],
    ["ends the list on an empty item", "- a\n- |", "- a\n|"],
    ["steps an empty nested item out a level", "- a\n  - |", "- a\n- |"],
    ["steps an empty nested number out and counts it", "1. a\n   1. |", "1. a\n2. |"],
  ])("%s", (_name, before, after) => {
    const { text, selection } = parse(before);
    expect(show(text, continueList(text, selection))).toBe(after);
  });

  test.each([
    ["outside a list", "milk|"],
    ["in a heading", "# milk|"],
    ["before the item's words", "|- milk"],
    ["with a selection across lines", "- a|\n- b|"],
  ])("is a plain newline %s", (_name, before) => {
    const { text, selection } = parse(before);
    expect(continueList(text, selection)).toBeUndefined();
  });
});

describe("Tab and Shift+Tab in a list", () => {
  test.each([
    ["nests a bullet under the one before", "- a\n- b|", false, "- a\n  - b|"],
    ["nests under a number at its words", "1. a\n2. b|", false, "1. a\n   1. b|"],
    ["nests a third level", "- a\n  - b\n  - c|", false, "- a\n  - b\n    - c|"],
    ["takes nested items along", "- a\n- |b\n  - c", false, "- a\n  - |b\n    - c"],
    ["counts the list it leaves again", "1. a\n2. b|\n3. c", false, "1. a\n   1. b|\n2. c"],
    ["steps out a level", "- a\n  - b|", true, "- a\n- b|"],
    ["steps a number out and counts it in", "1. a\n   1. b|", true, "1. a\n2. b|"],
    [
      "leaves the rest of a nested list starting at 1",
      "1. a\n   1. b\n   2. c|\n   3. d",
      true,
      "1. a\n   1. b\n2. c|\n   1. d",
    ],
    ["moves every item a selection covers", "- a\n- |b\n- c|", false, "- a\n  - |b\n  - c|"],
  ])("%s", (_name, before, outdent, after) => {
    const { text, selection } = parse(before);
    expect(show(text, indentList(text, selection, outdent))).toBe(after);
  });

  test.each([
    ["the first item can't nest", "- a|", false],
    ["a top-level item can't step out", "- a\n- b|", true],
  ])("does nothing when %s", (_name, before, outdent) => {
    const { text, selection } = parse(before);
    expect(indentList(text, selection, outdent)).toEqual({ steps: [], selection });
  });

  test("keeps its usual meaning outside a list", () => {
    const { text, selection } = parse("milk|");
    expect(indentList(text, selection, false)).toBeUndefined();
  });
});

describe("numbering", () => {
  test.each([
    ["a list after a deleted item", "1. a\n3. c", "1. a\n2. c"],
    ["each level on its own", "1. a\n   1. x\n   5. y\n2. b", "1. a\n   1. x\n   2. y\n2. b"],
    ["past nine", "9. a\n9. b", "9. a\n10. b"],
    ["a list that starts at 5 keeps 5", "5. a\n1. b", "5. a\n6. b"],
    ["a list broken by words starts over", "1. a\nwords\n7. b", "1. a\nwords\n7. b"],
    ["a numbered item after bullets starts its own list", "- a\n4. b", "- a\n4. b"],
    ["a year at a line's start alone", "2025. was a year", "2025. was a year"],
  ])("%s", (_name, before, after) => {
    expect(applyTextEdits(before, renumberEdits(before))).toBe(after);
  });
});

import { expect, test } from "vitest";
import { toggleBold } from "./composer-bold.ts";
import { applyTextChange } from "./composer-text-edits.ts";
import type { ComposerToken } from "./composer-tokens.ts";

/** `|` marks the caret; two of them mark a selection. */
function toggled(marked: string, tokens: readonly ComposerToken[] = []) {
  const start = marked.indexOf("|");
  const second = marked.indexOf("|", start + 1);
  const text = marked.replaceAll("|", "");
  const selection = { start, end: second === -1 ? start : second - 1 };
  const after = applyTextChange(text, tokens, toggleBold(text, selection, tokens));
  const { start: from, end: to } = after.selection;
  const shown =
    from === to
      ? after.text.slice(0, from) + "|" + after.text.slice(from)
      : after.text.slice(0, from) + "|" + after.text.slice(from, to) + "|" + after.text.slice(to);
  return { shown, tokens: after.tokens };
}

test.each([
  ["wraps the selected words", "make |this| bold", "make **|this|** bold"],
  ["leaves the spaces around a selection out", "make| this |bold", "make **|this|** bold"],
  ["takes bold off a selection inside bold words", "**make |this| bold**", "make |this| bold"],
  ["takes bold off its whole run, marks selected too", "|**bold**|", "|bold|"],
  ["merges a bold run the selection touches", "|plain **bo|ld**", "**|plain bo|ld**"],
  ["puts down marks at a bare caret", "say |", "say **|**"],
  ["takes bold off words the caret is in", "**bo|ld** text", "bo|ld text"],
  ["right after bold words carries them on", "**bold**| text", "**bold|** text"],
  ["right before bold words carries them on", "say |**bold**", "say **|bold**"],
  ["wraps each line of a selection on its own", "|one\ntwo|", "**|one**\n**two|**"],
  ["wraps a list item's words, not its marker", "- |milk|", "- **|milk|**"],
  ["does nothing to a selection of spaces", "a | | b", "a | | b"],
])("%s", (_name, before, after) => {
  expect(toggled(before).shown).toBe(after);
});

test("wrapping words around a chip keeps the chip", () => {
  const chip: ComposerToken = { start: 4, end: 9, label: "@a.ts", file: { path: "a.ts" } };
  const { shown, tokens } = toggled("see |@a.ts|", [chip]);
  expect(shown).toBe("see **|@a.ts|**");
  expect(tokens).toEqual([{ ...chip, start: 6, end: 11 }]);
});

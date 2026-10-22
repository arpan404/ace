import { lineEnd, lineStart, selectedLines, type Change, type Selection } from "./edits.ts";

/** A list item's opening: its indent, its marker ("-", "*", "+", "3." or "3)") and a task box. */
const item = /^(\s*)([-*+]|(\d+)([.)]))( \[[ xX]\])? /;

/**
 * Enter inside a list item: the next line starts with the same marker (the next number, an
 * unticked box), carrying whatever followed the caret. Enter on an item with nothing written
 * ends the list instead, leaving the line empty. Outside a list, `undefined`: a plain newline.
 */
export function continueList(selection: Selection): Change | undefined {
  const { value, start, end } = selection;
  if (start !== end) return undefined;
  const from = lineStart(value, start);
  const match = item.exec(value.slice(from, lineEnd(value, start)));
  if (!match || start < from + match[0].length) return undefined;
  const to = lineEnd(value, start);
  if (!value.slice(from + match[0].length, to).trim())
    return { from, to, insert: "", select: [from, from] };
  const [, indent = "", bullet = "", digits, closer, box] = match;
  const marker = digits === undefined ? bullet : `${Number(digits) + 1}${closer ?? "."}`;
  const insert = `\n${indent}${marker}${box ? " [ ]" : ""} `;
  return { from: start, to: start, insert, select: [start + insert.length, start + insert.length] };
}

/**
 * Tab and Shift+Tab on list items nest them one level deeper or bring them back out, by the
 * width of the item's own marker ("- " is two spaces, "1. " three). Lines that are not list
 * items are left alone; when none are, `undefined`, so Tab still moves focus.
 */
export function indentList(selection: Selection, outdent: boolean): Change | undefined {
  const { from, to } = selectedLines(selection);
  const lines = selection.value.slice(from, to).split("\n");
  if (!lines.some((line) => item.test(line))) return undefined;
  let firstShift = 0;
  const next = lines.map((line, index) => {
    const match = item.exec(line);
    if (!match) return line;
    const width = (match[2] ?? "-").length + 1;
    const indent = match[1] ?? "";
    const shift = outdent ? -Math.min(indent.length, width) : width;
    if (index === 0) firstShift = shift;
    return shift < 0 ? line.slice(-shift) : " ".repeat(shift) + line;
  });
  const insert = next.join("\n");
  if (insert === lines.join("\n")) return undefined;
  if (selection.start === selection.end) {
    const caret = Math.max(from, selection.start + firstShift);
    return { from, to, insert, select: [caret, caret] };
  }
  return { from, to, insert, select: [from, from + insert.length] };
}

import { selectedLines, type Change, type Selection } from "./edits.ts";

/** Marks that start a line: a heading, a quote and the three kinds of list. */
export type BlockMark = "heading" | "quote" | "bullets" | "numbers" | "tasks";

const task = /^(\s*)[-*+] \[[ xX]\] /;
const bullet = /^(\s*)[-*+] (?!\[[ xX]\] )/;
const number = /^(\s*)\d+[.)] /;
const patterns: Record<BlockMark, RegExp> = {
  heading: /^#{1,6} /,
  quote: /^> ?/,
  bullets: bullet,
  numbers: number,
  tasks: task,
};
/** Any list marker, so switching a bulleted line to numbers replaces its dash. */
const anyList = /^(\s*)(?:[-*+] \[[ xX]\] |[-*+] |\d+[.)] )/;

function prefix(mark: BlockMark, index: number): string {
  if (mark === "heading") return "### ";
  if (mark === "quote") return "> ";
  if (mark === "bullets") return "- ";
  if (mark === "numbers") return `${index + 1}. `;
  return "- [ ] ";
}

/**
 * Start every selected line with `mark`, or take it off when every line already has it.
 * Across several lines blank ones are left alone and numbers count up. A line that is a
 * different kind of list item changes kind. A caret moves with its text; a selection grows to
 * cover the whole lines it changed.
 */
export function toggleBlock(selection: Selection, mark: BlockMark): Change {
  const { from, to } = selectedLines(selection);
  const lines = selection.value.slice(from, to).split("\n");
  const marked = (line: string) => patterns[mark].test(line);
  const counted = lines.length > 1 ? lines.filter((line) => line.trim()) : lines;
  const removing = counted.length > 0 && counted.every(marked);
  let index = 0;
  const list = mark === "bullets" || mark === "numbers" || mark === "tasks";
  const next = lines.map((line) => {
    if (removing)
      return line.replace(patterns[mark], (_whole, indent: unknown) =>
        typeof indent === "string" ? indent : "",
      );
    if (lines.length > 1 && !line.trim()) return line;
    if (!list) return prefix(mark, index++) + line;
    const listed = anyList.exec(line);
    const indent = listed?.[1] ?? /^\s*/.exec(line)?.[0] ?? "";
    const text = line.slice(listed ? listed[0].length : indent.length);
    return indent + prefix(mark, index++) + text;
  });
  const insert = next.join("\n");
  if (selection.start === selection.end) {
    const first = (next[0] ?? "").length - (lines[0] ?? "").length;
    const caret = Math.max(from, selection.start + first);
    return { from, to, insert, select: [caret, caret] };
  }
  return { from, to, insert, select: [from, from + insert.length] };
}

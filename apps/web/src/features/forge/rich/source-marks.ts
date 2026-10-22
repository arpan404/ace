/*
 * Task boxes and footnote definitions found in the markdown source of PR and issue text
 * (ADR 0096), outside fenced code. Ticking a box rewrites only its `[ ]` or `[x]`, so an edit
 * through the forge's guarded write changes nothing else in the text.
 */

const fence = /^ {0,3}(`{3,}|~{3,})/;
// A list item's marker, optionally inside quotes, then the box.
const task = /^((?: {0,3}>\s?)*\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\](?=\s|$)/;
const footnote = /^ {0,3}\[\^([^\]\s]{1,64})\]:/;

/** Each line outside fenced code, with its offset in `source`. */
function* proseLines(source: string): Generator<{ line: string; at: number }> {
  let open: string | undefined;
  let at = 0;
  for (const line of source.split("\n")) {
    const opener = fence.exec(line)?.[1];
    if (open) {
      if (opener && opener[0] === open[0] && opener.length >= open.length) open = undefined;
    } else if (opener) open = opener;
    else yield { line, at };
    at += line.length + 1;
  }
}

/** Where each task box's mark sits in `source` (the offset of the character inside `[ ]`). */
export function taskMarks(source: string): number[] {
  const marks: number[] = [];
  for (const { line, at } of proseLines(source)) {
    const match = task.exec(line);
    if (match?.[1] !== undefined) marks.push(at + match[1].length + 1);
  }
  return marks;
}

/**
 * `source` with its `index`th task box set to `checked`; undefined when there is no such box or
 * the source holds a different number of boxes than the page drew (`drawn`), so the boxes can't
 * be matched to the text with certainty.
 */
export function withTask(
  source: string,
  index: number,
  checked: boolean,
  drawn: number,
): string | undefined {
  const marks = taskMarks(source);
  const at = marks[index];
  if (marks.length !== drawn || at === undefined) return undefined;
  return source.slice(0, at) + (checked ? "x" : " ") + source.slice(at + 1);
}

/** Footnote labels in the order they are defined, numbered from 1. */
export function footnoteNumbers(source: string): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const { line } of proseLines(source)) {
    const label = footnote.exec(line)?.[1];
    if (label !== undefined && !numbers.has(label)) numbers.set(label, numbers.size + 1);
  }
  return numbers;
}

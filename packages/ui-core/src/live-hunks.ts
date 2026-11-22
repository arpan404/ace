import type { ChangeHunk } from "./change-hunks.ts";
import type { LineMark } from "./line-marks.ts";

/*
 * The editor's change marks while the person types (docs/editor/workbench.md 44): the buffer's
 * text against the committed one, from the whole-line changes the editor core finds between
 * them (the committed text itself is rebuilt exactly from git's patch: `exact-patch.ts`). Pure,
 * and linear in the changes.
 */

/** One whole-line change, 0-based, `end` exclusive, `text` with its line endings: the core's. */
export interface WholeLineChange {
  start: number;
  end: number;
  text: string;
}

/** A text's lines without their endings; a trailing ending opens no extra line. */
export function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Hunks for the buffer's gutter from the changes that turn its text into the committed text
 * (`lineChanges(current, committed)`): each change's current lines are what the file has now,
 * its text what it replaced. A hunk's marks follow `lineMarks`: as many lines "modified" as both
 * sides have, the rest "added", and a pure removal marks the line below it (the last line at the
 * end of the file).
 */
export function hunksFromChanges(
  changes: readonly WholeLineChange[],
  lineAt: (line: number) => string,
  lineCount: number,
): ChangeHunk[] {
  const hunks: ChangeHunk[] = [];
  for (const change of changes) {
    const added: string[] = [];
    for (let line = change.start; line < change.end && line < lineCount; line++)
      added.push(lineAt(line));
    const removed = linesOf(change.text);
    const marks = added.length
      ? added.map((_, index) => change.start + 1 + index)
      : [Math.min(change.start + 1, Math.max(1, lineCount))];
    const end = change.start + added.length;
    hunks.push({
      start: change.start + 1,
      marks,
      added,
      removed,
      removedText: change.text,
      above: change.start > 0 ? lineAt(change.start - 1) : undefined,
      below: end < lineCount ? lineAt(end) : undefined,
    });
  }
  return hunks;
}

/** The gutter marks of `hunks`, by 1-based line. */
export function hunkMarks(hunks: readonly ChangeHunk[]): Map<number, LineMark> {
  const marks = new Map<number, LineMark>();
  for (const hunk of hunks) {
    if (hunk.added.length === 0) {
      const line = hunk.marks[0];
      if (line !== undefined && !marks.has(line)) marks.set(line, "removed");
      continue;
    }
    hunk.marks.forEach((line, index) =>
      marks.set(line, index < hunk.removed.length ? "modified" : "added"),
    );
  }
  return marks;
}

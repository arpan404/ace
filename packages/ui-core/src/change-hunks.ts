import type { DiffRow } from "./diff.ts";

/*
 * A file's changes since the last commit as hunks, for the editor's gutter: what a run of changed
 * lines is now and what it replaced, which gutter lines mark it (as `lineMarks` places them), and
 * the edit that puts the committed lines back. Pure and linear in the rows.
 */

export interface ChangeHunk {
  /** The 1-based line of the current text where the hunk starts; for a removal, the line after it. */
  start: number;
  /** The 1-based lines whose gutter mark belongs to this hunk. */
  marks: readonly number[];
  /** The current text's lines in the hunk; empty when lines were only removed. */
  added: readonly string[];
  /** The committed lines the hunk replaced; empty when lines were only added. */
  removed: readonly string[];
  /**
   * The committed lines exactly as they were, line endings included, when known (a live diff):
   * a revert puts back this text, not the lines rejoined.
   */
  removedText?: string | undefined;
  /** The unchanged line just above the hunk, when known: a revert checks it is still there. */
  above?: string | undefined;
  /** The unchanged line just below it. A removal has no lines of its own: these anchor it. */
  below?: string | undefined;
}

/** An edit by whole lines, 0-based, `end` exclusive: the shape the editor lands. */
export interface LineReplacement {
  start: number;
  end: number;
  text: string;
}

export function changeHunks(rows: readonly DiffRow[]): ChangeHunk[] {
  const hunks: ChangeHunk[] = [];
  let open: { start: number; added: string[]; removed: string[] } | undefined;
  let lastNew = 0;
  const close = (next: number | undefined) => {
    if (!open) return;
    const { start, added, removed } = open;
    // A removal is marked on the line below it, or on the last line at the end of the file.
    const marks = added.length
      ? added.map((_, index) => start + index)
      : [next ?? Math.max(1, lastNew)];
    hunks.push({ start, marks, added, removed });
    open = undefined;
  };
  for (const row of rows) {
    if (row.kind === "del") {
      open ??= { start: lastNew + 1, added: [], removed: [] };
      // Lines removed after lines added start a hunk of their own.
      if (open.added.length) {
        close(lastNew + 1);
        open = { start: lastNew + 1, added: [], removed: [] };
      }
      open.removed.push(row.text);
      continue;
    }
    if (row.kind === "add") {
      open ??= { start: row.new ?? lastNew + 1, added: [], removed: [] };
      open.added.push(row.text);
      lastNew = row.new ?? lastNew + 1;
      continue;
    }
    const next = row.kind === "fold" ? undefined : row.new;
    close(next);
    if (next !== undefined) lastNew = next;
    // A fold hides unchanged lines of unknown count: the next row says where the text resumes.
  }
  close(undefined);
  return hunks;
}

/** The hunk a gutter mark on `line` (1-based) belongs to. */
export function hunkAt(hunks: readonly ChangeHunk[], line: number): ChangeHunk | undefined {
  return hunks.find((hunk) => hunk.marks.includes(line));
}

/**
 * The edit that puts a hunk's committed lines back, or undefined when the text no longer has the
 * hunk's lines (and the unchanged lines around it, where known) where the diff said: it changed
 * since the diff was read.
 */
export function revertChange(
  hunk: ChangeHunk,
  lineAt: (line: number) => string,
  lineCount: number,
): LineReplacement | undefined {
  const start = hunk.start - 1;
  const end = start + hunk.added.length;
  if (start < 0 || end > lineCount) return undefined;
  for (let index = 0; index < hunk.added.length; index++)
    if (lineAt(start + index) !== hunk.added[index]) return undefined;
  if (hunk.above !== undefined && (start === 0 || lineAt(start - 1) !== hunk.above))
    return undefined;
  if (hunk.below !== undefined && (end >= lineCount || lineAt(end) !== hunk.below))
    return undefined;
  if (hunk.removedText !== undefined) return { start, end, text: hunk.removedText };
  const text = hunk.removed.map((line) => `${line}\n`).join("");
  // Lines replaced through the file's last line, which has no ending: the put-back text has none.
  return { start, end, text: end === lineCount ? text.slice(0, -1) : text };
}

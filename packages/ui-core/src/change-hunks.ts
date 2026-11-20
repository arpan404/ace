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
 * hunk's lines where the diff said (it changed since the diff was read).
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
  return { start, end, text: hunk.removed.map((line) => `${line}\n`).join("") };
}

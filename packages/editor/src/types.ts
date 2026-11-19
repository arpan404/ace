/**
 * A caret or endpoint: zero-based line and UTF-16 column, the unit the DOM reports.
 */
export interface Position {
  line: number;
  column: number;
}

/** One cursor: where the selection began and where the moving end is. */
export interface Selection {
  anchor: Position;
  head: Position;
}

/** An ordered span between two positions; equal positions are a caret. */
export interface Range {
  start: Position;
  end: Position;
}

/** One change in a transaction, in the coordinates of the document before it. */
export interface Change {
  range: Range;
  text: string;
}

/** One changed region, in post-edit coordinates, ready for a line highlighter. */
export interface LineEdit {
  /** The first changed line, zero-based, in the document after the edit. */
  firstLine: number;
  /** How many old lines the region covered, counting the first. */
  removedLines: number;
  /** How many new lines the region covers, counting the first. */
  insertedLines: number;
}

/** One range a transaction replaced: its old bounds and where the new text ends. */
export interface TextReplacement {
  /** Where the replaced text began, in the document before the transaction. */
  start: Position;
  /** Where the replaced text ended, in the document before the transaction. */
  end: Position;
  /** Where the text that replaced it ends, in the document after the transaction. */
  postEnd: Position;
}

/** What a completed edit changed: the document version and one entry per changed region. */
export interface Applied {
  version: number;
  spans: LineEdit[];
  /** The replaced ranges in document order, for carrying a stored position through the edit. */
  replacements: TextReplacement[];
}

/** A find request: literal by default, case-sensitive and not whole-word unless asked. */
export interface FindQuery {
  pattern: string;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

/** How one indent step is written: a tab, or `size` spaces (`size` is also a tab's width). */
export interface Indent {
  tabs: boolean;
  size: number;
}

/** How a line of the current text differs from the original. */
export type LineMarkKind = "added" | "modified" | "removed";

/** One gutter mark on a 1-based line of the current text. */
export interface LineMark {
  line: number;
  kind: LineMarkKind;
}

/** A rejection from the editor core, carrying the shared code (`INVALID_ARGUMENT` today). */
export interface EditorError extends Error {
  code: string;
}

/** Whether an unknown thrown value is an editor rejection with a `code`. */
export function isEditorError(error: unknown): error is EditorError {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

import { flattenSelections, readApplied, readRanges, readSelections } from "./flat.ts";
import { wasm } from "./loader.ts";
import type { Applied, Change, FindQuery, Position, Range, Selection } from "./types.ts";
import type { WasmDocument } from "./wasm-types.ts";

/**
 * One open text file: text, cursors, undo history and the editing commands.
 *
 * The class is a thin edge over the Wasm core. Positions are `{ line, column }` with UTF-16
 * columns here and flat numbers on the boundary; edits and commands return the exact regions a
 * highlighter must re-parse, and reading text is explicit: `lines` for what a view draws,
 * `text` only when the whole file is needed.
 *
 * A rejected call throws a JavaScript `Error` with a `code` property (`INVALID_ARGUMENT`).
 */
export class EditorDocument {
  readonly #inner: WasmDocument;

  /** A document holding `text`, with one caret at the start. */
  constructor(text: string) {
    this.#inner = new (wasm().EditorDocument)(text);
  }

  /** The whole text, with its original line endings. Ask only when the whole file is needed. */
  text(): string {
    return this.#inner.text();
  }

  /** The number of lines. A trailing line break leaves a last empty line. */
  lenLines(): number {
    return this.#inner.lenLines();
  }

  /** One line without its line ending. An index past the end is empty. */
  line(index: number): string {
    return this.#inner.line(index);
  }

  /** Lines `start..end` without their endings, as one array for the visible range. */
  lines(start: number, end: number): string[] {
    return this.#inner.lines(start, end);
  }

  /** The line ending the document was loaded with. */
  lineEnding(): "\n" | "\r\n" {
    return this.#inner.lineEnding() === "\r\n" ? "\r\n" : "\n";
  }

  /** The number of edits applied so far. */
  version(): number {
    return this.#inner.version();
  }

  /** Every cursor, in document order. */
  selections(): Selection[] {
    return readSelections(this.#inner.selections());
  }

  /** The index in {@link EditorDocument.selections} of the newest cursor. */
  primarySelection(): number {
    return this.#inner.primarySelection();
  }

  /** Replaces every cursor; the last one becomes primary. */
  setSelections(selections: readonly Selection[]): void {
    this.#inner.setSelections(flattenSelections(selections));
  }

  /**
   * Applies one transaction, one change per cursor at most. Throws `INVALID_ARGUMENT` when two
   * ranges overlap or a list is malformed.
   */
  apply(changes: readonly Change[]): Applied {
    const ranges = new Uint32Array(changes.length * 4);
    const texts: string[] = [];
    for (const [index, change] of changes.entries()) {
      const { start, end } = change.range;
      ranges.set([start.line, start.column, end.line, end.column], index * 4);
      texts.push(change.text);
    }
    return readApplied(this.#inner.apply(ranges, texts));
  }

  /** Inserts `text` at every cursor, replacing selected text. */
  insertText(text: string): Applied {
    return readApplied(this.#inner.insertText(text));
  }

  /** Inserts a line break carrying the current line's indentation at every cursor. */
  insertNewline(): Applied {
    return readApplied(this.#inner.insertNewline());
  }

  /** Deletes the selected text, or one grapheme cluster before each caret. */
  backspace(): Applied {
    return readApplied(this.#inner.backspace());
  }

  /** Deletes the selected text, or the word before each caret. */
  deleteWordBackward(): Applied {
    return readApplied(this.#inner.deleteWordBackward());
  }

  /** Adds one indent step to the start of every selected line. */
  indentLines(): Applied {
    return readApplied(this.#inner.indentLines());
  }

  /** Removes one indent step from every selected line. */
  outdentLines(): Applied {
    return readApplied(this.#inner.outdentLines());
  }

  /** Swaps the selected lines with the line above them. */
  moveLinesUp(): Applied {
    return readApplied(this.#inner.moveLinesUp());
  }

  /** Swaps the selected lines with the line below them. */
  moveLinesDown(): Applied {
    return readApplied(this.#inner.moveLinesDown());
  }

  /** Copies the selected lines below themselves and moves the carets onto the copies. */
  duplicateLines(): Applied {
    return readApplied(this.#inner.duplicateLines());
  }

  /** Comments the selected lines with `token`, or removes it when all are commented. */
  toggleLineComment(token: string): Applied {
    return readApplied(this.#inner.toggleLineComment(token));
  }

  /** Undoes the last step, or `undefined` when there is nothing to undo. */
  undo(): Applied | undefined {
    const applied = this.#inner.undo();
    return applied ? readApplied(applied) : undefined;
  }

  /** Redoes the step undone last, or `undefined` when there is nothing to redo. */
  redo(): Applied | undefined {
    const applied = this.#inner.redo();
    return applied ? readApplied(applied) : undefined;
  }

  /** Ends the current typing run, so the next keystroke is a separate undo step. */
  commit(): void {
    this.#inner.commit();
  }

  /** Finds at most `limit` matches, in document order. */
  find(query: FindQuery, limit = 1_000): Range[] {
    return readRanges(
      this.#inner.find(
        query.pattern,
        query.regex ?? false,
        query.caseSensitive ?? true,
        query.wholeWord ?? false,
        limit,
      ),
    );
  }

  /** Selects a box from `anchor` to `head`, with columns as visual columns. */
  selectColumn(anchor: Position, head: Position, tabSize = 4): void {
    this.#inner.selectColumn(anchor.line, anchor.column, head.line, head.column, tabSize);
  }

  /** Adds a cursor over the next occurrence of the primary selection's text. */
  selectNextOccurrence(): boolean {
    return this.#inner.selectNextOccurrence();
  }

  /** Releases the Wasm-side document now instead of at garbage collection. */
  dispose(): void {
    this.#inner.free();
  }
}

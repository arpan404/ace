import { flattenSelections, readApplied, readRanges, readSelections } from "./flat.ts";
import { wasm } from "./loader.ts";
import type { Applied, Change, FindQuery, Indent, Position, Range, Selection } from "./types.ts";
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

  /** Rewrites every line break with `ending` as one undo step; new lines use it from now on. */
  setLineEnding(ending: "\n" | "\r\n"): Applied {
    return readApplied(this.#inner.setLineEnding(ending === "\r\n"));
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

  /** Copies the selected lines above themselves; the carets stay on the upper copy. */
  copyLinesUp(): Applied {
    return readApplied(this.#inner.copyLinesUp());
  }

  /** Deletes every selected line; each caret lands on the line that moves into its place. */
  deleteLines(): Applied {
    return readApplied(this.#inner.deleteLines());
  }

  /** Opens an empty line below each caret's line, indented like it. */
  insertLineBelow(): Applied {
    return readApplied(this.#inner.insertLineBelow());
  }

  /** Opens an empty line above each caret's line, indented like it. */
  insertLineAbove(): Applied {
    return readApplied(this.#inner.insertLineAbove());
  }

  /** Joins each selection's lines into one, or a caret's line with the next. */
  joinLines(): Applied {
    return readApplied(this.#inner.joinLines());
  }

  /** Tab: indents a multi-line selection's lines, or inserts one indent step at every caret. */
  tab(): Applied {
    return readApplied(this.#inner.tab());
  }

  /** Wraps each selection in a block comment, or unwraps one that already is. */
  toggleBlockComment(open: string, close: string): Applied {
    return readApplied(this.#inner.toggleBlockComment(open, close));
  }

  /**
   * Types one keystroke at every cursor: brackets and quotes close themselves, a closer types
   * over the same character, and a bracket over a selection wraps it. Pastes use `insertText`.
   */
  typeText(text: string): Applied {
    return readApplied(this.#inner.typeText(text));
  }

  /** Enter: the line's indentation, one step more after an opening bracket, split in a pair. */
  smartNewline(): Applied {
    return readApplied(this.#inner.smartNewline());
  }

  /** Backspace: one indent step in leading spaces, both halves of an empty pair, else one grapheme. */
  smartBackspace(): Applied {
    return readApplied(this.#inner.smartBackspace());
  }

  /** The indentation the start of the text uses, or undefined when no line is indented. */
  detectIndent(): Indent | undefined {
    const [tabs, size] = this.#inner.detectIndent();
    return size === undefined ? undefined : { tabs: tabs === 1, size };
  }

  /**
   * The bracket pair a caret at `at` highlights: the bracket just before it, else the one after
   * it, and its match. Scans at most `limit` characters; undefined when there is no pair.
   */
  matchingBracket(at: Position, limit = 20_000): [Range, Range] | undefined {
    const [first, second] = readRanges(this.#inner.matchingBracket(at.line, at.column, limit));
    return first && second ? [first, second] : undefined;
  }

  /** How one indent step is written. */
  indent(): Indent {
    const [tabs = 0, size = 2] = this.#inner.indent();
    return { tabs: tabs === 1, size };
  }

  /** Sets how indent commands, Tab and new lines write one indent step. */
  setIndent(indent: Indent): void {
    this.#inner.setIndent(indent.tabs, indent.size);
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
    return readRanges(this.#inner.find(...queryArgs(query), limit));
  }

  /** Finds at most `limit` matches lying wholly inside one of `within`, in document order. */
  findWithin(query: FindQuery, within: readonly Range[], limit = 1_000): Range[] {
    const q = queryArgs(query);
    return readRanges(this.#inner.findWithin(...q, flattenRanges(within), limit));
  }

  /**
   * Replaces every match, or only those inside `within` when it is not empty, as one undo step.
   * A regex query expands `$1` and `${name}` groups and `\n`, `\t` escapes.
   */
  replaceAll(query: FindQuery, replacement: string, within: readonly Range[] = []): Applied {
    return readApplied(
      this.#inner.replaceAll(...queryArgs(query), replacement, flattenRanges(within)),
    );
  }

  /** Replaces the match at `at` when it is still exactly a match; otherwise changes nothing. */
  replaceMatch(query: FindQuery, at: Range, replacement: string): Applied {
    return readApplied(
      this.#inner.replaceMatch(...queryArgs(query), flattenRanges([at]), replacement),
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

  /** Selects every occurrence of the primary selection's text, or of the word at a caret. */
  selectAllOccurrences(): boolean {
    return this.#inner.selectAllOccurrences();
  }

  /** Moves the newest selection on to the next occurrence of its text (Cmd+K Cmd+D). */
  skipOccurrence(): boolean {
    return this.#inner.skipOccurrence();
  }

  /**
   * Grows every selection to the smallest larger unit around it: word, the text inside the
   * brackets, the brackets, the line, the indented block, the document. False when none grows.
   */
  expandSelection(): boolean {
    return this.#inner.expandSelection();
  }

  /** Releases the Wasm-side document now instead of at garbage collection. */
  dispose(): void {
    this.#inner.free();
  }
}

function queryArgs(query: FindQuery): [string, boolean, boolean, boolean] {
  return [
    query.pattern,
    query.regex ?? false,
    query.caseSensitive ?? true,
    query.wholeWord ?? false,
  ];
}

function flattenRanges(ranges: readonly Range[]): Uint32Array {
  const flat = new Uint32Array(ranges.length * 4);
  for (const [index, { start, end }] of ranges.entries())
    flat.set([start.line, start.column, end.line, end.column], index * 4);
  return flat;
}

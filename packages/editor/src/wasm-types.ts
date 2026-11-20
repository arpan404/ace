/** The shapes the generated wasm-bindgen glue exports, typed by hand so the package builds
 * without a generated `pkg/` folder; only its presence at runtime needs the built Wasm. */

/** The `Applied` class wasm-bindgen generates. */
export interface WasmApplied {
  readonly version: number;
  readonly spans: Uint32Array;
  readonly replacements: Uint32Array;
}

/** The `EditorDocument` class wasm-bindgen generates, in its flat-array shape. */
export interface WasmDocument {
  text(): string;
  lenLines(): number;
  line(index: number): string;
  lines(start: number, end: number): string[];
  lineEnding(): string;
  version(): number;
  selections(): Uint32Array;
  primarySelection(): number;
  setSelections(quads: Uint32Array): void;
  apply(ranges: Uint32Array, texts: string[]): WasmApplied;
  insertText(text: string): WasmApplied;
  insertNewline(): WasmApplied;
  backspace(): WasmApplied;
  deleteWordBackward(): WasmApplied;
  indentLines(): WasmApplied;
  outdentLines(): WasmApplied;
  moveLinesUp(): WasmApplied;
  moveLinesDown(): WasmApplied;
  duplicateLines(): WasmApplied;
  toggleLineComment(token: string): WasmApplied;
  undo(): WasmApplied | undefined;
  redo(): WasmApplied | undefined;
  commit(): void;
  find(
    pattern: string,
    regex: boolean,
    caseSensitive: boolean,
    wholeWord: boolean,
    limit: number,
  ): Uint32Array;
  selectColumn(
    anchorLine: number,
    anchorColumn: number,
    headLine: number,
    headColumn: number,
    tabSize: number,
  ): void;
  selectNextOccurrence(): boolean;
  free(): void;
}

/** The generated module: its default export instantiates the Wasm, the rest are bindings. */
export interface WasmGlue {
  default(input?: unknown): Promise<unknown>;
  EditorDocument: new (text: string) => WasmDocument;
  lineMarks(original: string, current: string): Uint32Array;
  merge3(base: string, mine: string, theirs: string): string[];
}

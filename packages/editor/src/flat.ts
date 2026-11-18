import type { Applied, LineEdit, Position, Range, Selection } from "./types.ts";
import type { WasmApplied } from "./wasm-types.ts";

/** Positions to the quads the boundary reads. */
export function flattenSelections(selections: readonly Selection[]): Uint32Array {
  const flat = new Uint32Array(selections.length * 4);
  for (const [index, selection] of selections.entries()) {
    flat.set(quad(selection.anchor, selection.head), index * 4);
  }
  return flat;
}

/** The quads the boundary returns, as positions. */
export function readSelections(flat: Uint32Array): Selection[] {
  const selections: Selection[] = [];
  for (let index = 0; index + 3 < flat.length; index += 4) {
    selections.push({
      anchor: point(flat[index] ?? 0, flat[index + 1] ?? 0),
      head: point(flat[index + 2] ?? 0, flat[index + 3] ?? 0),
    });
  }
  return selections;
}

/** The range quads the boundary returns, as ordered ranges. */
export function readRanges(flat: Uint32Array): Range[] {
  const ranges: Range[] = [];
  for (let index = 0; index + 3 < flat.length; index += 4) {
    ranges.push({
      start: point(flat[index] ?? 0, flat[index + 1] ?? 0),
      end: point(flat[index + 2] ?? 0, flat[index + 3] ?? 0),
    });
  }
  return ranges;
}

/** One applied edit, with its span triples turned into named offsets. */
export function readApplied(raw: WasmApplied): Applied {
  const flat = raw.spans;
  const spans: LineEdit[] = [];
  for (let index = 0; index + 2 < flat.length; index += 3) {
    spans.push({
      firstLine: flat[index] ?? 0,
      removedLines: flat[index + 1] ?? 0,
      insertedLines: flat[index + 2] ?? 0,
    });
  }
  return { version: raw.version, spans };
}

function quad(anchor: Position, head: Position): Uint32Array {
  return new Uint32Array([anchor.line, anchor.column, head.line, head.column]);
}

function point(line: number, column: number): Position {
  return { line, column };
}

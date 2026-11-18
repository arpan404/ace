import { wasm } from "./loader.ts";
import type { LineMark, LineMarkKind } from "./types.ts";

const kinds: readonly LineMarkKind[] = ["added", "modified", "removed"];

/**
 * Gutter marks for `current`, by 1-based line number, from its difference to `original`.
 *
 * A line carries at most one mark, in ascending line order. A replaced block marks "modified"
 * as many lines as both sides have and "added" for the rest; when it removed more lines than it
 * added, one "removed" marks the line just below it, or the last line at the end of the file.
 */
export function lineMarks(original: string, current: string): LineMark[] {
  const flat = wasm().lineMarks(original, current);
  const marks: LineMark[] = [];
  for (let index = 0; index + 1 < flat.length; index += 2) {
    marks.push({
      line: flat[index] ?? 0,
      kind: kinds[flat[index + 1] ?? 0] ?? "added",
    });
  }
  return marks;
}

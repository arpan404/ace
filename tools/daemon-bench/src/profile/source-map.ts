import { readFileSync } from "node:fs";
import { z } from "zod";

const SourceMap = z.object({
  sources: z.array(z.string()),
  names: z.array(z.string()).default([]),
  mappings: z.string(),
});
/** One generated line: ascending columns, each with its source index (or -1) and name. */
interface Line {
  columns: number[];
  sources: number[];
  names: number[];
}
export interface Original {
  source: string;
  name: string | undefined;
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const digit = new Int8Array(128).fill(-1);
for (let index = 0; index < alphabet.length; index++) digit[alphabet.charCodeAt(index)] = index;

/** A decoded source map that answers "which source file holds this generated position". */
export class MappedFile {
  private readonly lines: Line[] = [];
  private readonly sources: string[];
  private readonly names: string[];
  constructor(path: string) {
    const map = SourceMap.parse(JSON.parse(readFileSync(path, "utf8")));
    this.sources = map.sources;
    this.names = map.names;
    let source = 0;
    let name = 0;
    let line: Line = { columns: [], sources: [], names: [] };
    let column = 0;
    let fields: number[] = [];
    let value = 0;
    let shift = 0;
    const segment = () => {
      if (fields.length === 0) return;
      column += fields[0] ?? 0;
      let sourceIndex = -1;
      let nameIndex = -1;
      if (fields.length >= 4) {
        source += fields[1] ?? 0;
        sourceIndex = source;
      }
      if (fields.length >= 5) {
        name += fields[4] ?? 0;
        nameIndex = name;
      }
      line.columns.push(column);
      line.sources.push(sourceIndex);
      line.names.push(nameIndex);
      fields = [];
    };
    const text = map.mappings;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code === 59 /* ; */) {
        segment();
        this.lines.push(line);
        line = { columns: [], sources: [], names: [] };
        column = 0;
        continue;
      }
      if (code === 44 /* , */) {
        segment();
        continue;
      }
      const bits = digit[code] ?? -1;
      if (bits < 0) throw new Error(`Bad source map character at ${index}`);
      value += (bits & 31) << shift;
      if (bits & 32) {
        shift += 5;
        continue;
      }
      fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
    segment();
    this.lines.push(line);
  }
  /** Zero-based generated line and column, as V8 profiles report them. */
  lookup(lineNumber: number, columnNumber: number): Original | undefined {
    const line = this.lines[lineNumber];
    if (!line || line.columns.length === 0) return undefined;
    let low = 0;
    let high = line.columns.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((line.columns[middle] ?? 0) <= columnNumber) low = middle;
      else high = middle - 1;
    }
    const sourceIndex = line.sources[low] ?? -1;
    if (sourceIndex < 0) return undefined;
    const nameIndex = line.names[low] ?? -1;
    return {
      source: this.sources[sourceIndex] ?? "?",
      name: nameIndex >= 0 ? this.names[nameIndex] : undefined,
    };
  }
}

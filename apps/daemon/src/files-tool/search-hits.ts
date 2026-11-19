import type { FileMatches, SearchQuery } from "@ace/files-native";
import type { FileOperation, FileSearchFile, FileSearchLine } from "@ace/protocol";

/** The most highlight ranges one preview line carries; a line of one-letter matches is cut. */
export const maxRangesPerLine = 256;

type SearchOperation = Extract<FileOperation, { op: "search" }>;

/** The ace-files query a client's `search` operation asks for. */
export function searchQuery(operation: SearchOperation): SearchQuery {
  return {
    pattern: operation.pattern,
    regex: operation.regex,
    case: operation.case,
    wholeWord: operation.wholeWord,
    include: operation.include,
    exclude: operation.exclude,
    includeIgnored: operation.includeIgnored,
    maxMatches: operation.maxMatches,
    maxFileBytes: operation.maxFileBytes,
  };
}

/** Bytes of a code point in UTF-8. */
function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Turn a preview's UTF-8 byte ranges (what ace-files reports) into UTF-16 offsets (what an
 * editor counts). A byte offset inside a character lands on that character's start; one past
 * the end lands on the end. One pass over the preview, whatever the number of ranges.
 */
export function utf16Ranges(
  preview: string,
  ranges: readonly (readonly [number, number])[],
): [number, number][] {
  if (!ranges.length) return [];
  const offsets = new Map<number, number>();
  for (const [start, end] of ranges) {
    offsets.set(start, 0);
    offsets.set(end, 0);
  }
  const wanted = [...offsets.keys()].toSorted((a, b) => a - b);
  let next = 0;
  let bytes = 0;
  let units = 0;
  for (const character of preview) {
    const codePoint = character.codePointAt(0) ?? 0;
    const after = bytes + utf8Length(codePoint);
    while (next < wanted.length && (wanted[next] ?? 0) < after) {
      offsets.set(wanted[next] ?? 0, units);
      next++;
    }
    bytes = after;
    units += character.length;
  }
  for (; next < wanted.length; next++) offsets.set(wanted[next] ?? 0, units);
  return ranges.map(([start, end]) => [offsets.get(start) ?? 0, offsets.get(end) ?? 0]);
}

/** One file's matches from ace-files as a client reads them. */
export function searchLines(file: FileMatches): FileSearchLine[] {
  return file.lines.map((line) => ({
    line: Math.max(1, line.line),
    column: line.column,
    preview: line.preview,
    ranges: utf16Ranges(line.preview, line.ranges.slice(0, maxRangesPerLine)),
  }));
}

/** Append `lines` of `path` to a batch, joining the batch's last file when it is the same one. */
export function appendLines(batch: FileSearchFile[], path: string, lines: FileSearchLine[]): void {
  if (!lines.length) return;
  const last = batch.at(-1);
  if (last?.path === path) last.lines.push(...lines);
  else batch.push({ path, lines });
}

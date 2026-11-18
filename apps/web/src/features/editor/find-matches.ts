import type { FindQuery, Range } from "@ace/editor";

/** One highlighted piece of a line: a find match clipped to that line. */
export interface MatchSegment {
  start: number;
  end: number;
  /** The match the find bar is currently on. */
  current: boolean;
}

/** The part of `range` that lies on `line`, if any. */
export function segmentOnLine(
  range: Range,
  line: number,
): { start: number; end: number } | undefined {
  if (line < range.start.line || line > range.end.line) return undefined;
  return {
    start: line === range.start.line ? range.start.column : 0,
    end: line === range.end.line ? range.end.column : Number.MAX_SAFE_INTEGER,
  };
}

/** The visible line's matches, with the current one marked, ready for the renderer. */
export function segmentsForLine(
  ranges: readonly Range[],
  line: number,
  currentIndex: number,
): MatchSegment[] | undefined {
  let segments: MatchSegment[] | undefined;
  ranges.forEach((range, index) => {
    const part = segmentOnLine(range, line);
    if (!part) return;
    segments ??= [];
    segments.push({ ...part, current: index === currentIndex });
  });
  return segments;
}

/** Where the caret starts for a find that opens on a selection. */
export function queryFromSelection(text: string): string {
  if (text.includes("\n") || text.length > 200) return "";
  return text;
}

/** A find request from the find bar's fields. */
export function findQuery(input: {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}): FindQuery {
  return {
    pattern: input.query,
    regex: input.regex,
    caseSensitive: input.caseSensitive,
    wholeWord: input.wholeWord,
  };
}

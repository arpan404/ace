/*
 * Find in a terminal's scrollback (or any list of output lines): plain or regular-expression
 * queries, optionally case-sensitive, at most `limit` matches so a pathological query over a
 * long build log stays cheap. Pure; the views map a match back to their own rows.
 */

export interface FindOptions {
  caseSensitive: boolean;
  regex: boolean;
}

export interface Match {
  /** Index of the line in the searched list. */
  line: number;
  /** Character offsets within that line, end exclusive. */
  start: number;
  end: number;
}

export interface FindResult {
  matches: readonly Match[];
  /** More matches exist than were returned. */
  truncated: boolean;
  /** Why the query can't be used (an invalid regular expression). */
  error?: string | undefined;
}

export const defaultFindOptions: FindOptions = { caseSensitive: false, regex: false };
const none: FindResult = { matches: [], truncated: false };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function findMatches(
  lines: readonly string[],
  query: string,
  options: FindOptions = defaultFindOptions,
  limit = 2000,
): FindResult {
  if (!query) return none;
  let pattern: RegExp;
  try {
    pattern = new RegExp(options.regex ? query : escape(query), options.caseSensitive ? "g" : "gi");
  } catch (error) {
    return { ...none, error: error instanceof Error ? error.message : "Invalid expression" };
  }
  const matches: Match[] = [];
  for (let line = 0; line < lines.length; line++) {
    const text = lines[line] ?? "";
    pattern.lastIndex = 0;
    for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
      // An empty match (`^`, `a*`) would never advance; skip past it, it highlights nothing.
      if (found[0].length === 0) {
        pattern.lastIndex++;
        continue;
      }
      if (matches.length === limit) return { matches, truncated: true };
      matches.push({ line, start: found.index, end: found.index + found[0].length });
    }
  }
  return { matches, truncated: false };
}

/** The match after (`delta` 1) or before (-1) `current`, wrapping; -1 when there are none. */
export function stepMatch(count: number, current: number, delta: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/**
 * Where a new search starts: the last match at or above `line` (the newest output a person is
 * looking at), else the last match. Terminals search upward from the bottom.
 */
export function startingMatch(matches: readonly Match[], line = Number.POSITIVE_INFINITY): number {
  for (let index = matches.length - 1; index >= 0; index--)
    if ((matches[index]?.line ?? 0) <= line) return index;
  return matches.length - 1;
}

/**
 * Lines as a reader sees them from rows that wrap: a row flagged `wrapped` continues the row
 * before it. Returns the joined lines and, for each line, the row it starts at, so a match can
 * be mapped back to a row and column (`rowColumn`).
 */
export function joinWrapped(rows: readonly { text: string; wrapped: boolean }[]): {
  lines: string[];
  starts: number[];
} {
  const lines: string[] = [];
  const starts: number[] = [];
  rows.forEach((row, index) => {
    if (row.wrapped && lines.length) lines[lines.length - 1] += row.text;
    else {
      lines.push(row.text);
      starts.push(index);
    }
  });
  return { lines, starts };
}

/** A character offset in a joined line, as a row and column of `columns`-wide rows. */
export function rowColumn(
  starts: readonly number[],
  match: Match,
  columns: number,
): { row: number; column: number } {
  const first = starts[match.line] ?? 0;
  const width = Math.max(1, columns);
  return { row: first + Math.floor(match.start / width), column: match.start % width };
}

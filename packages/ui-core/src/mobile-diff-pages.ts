import { pairRows, type DiffLine, type DiffRow } from "./diff.ts";
import { clipText } from "./mobile-changes.ts";

/*
 * One file's diff for a phone, page by page instead of within one budget: rows go out in pages
 * of a few hundred, so a 20,000-line file is all reachable without ever sending it at once. A
 * page never ends inside a run of removed and added lines (up to some slack), so the split
 * layout pairs a change with its replacement on one page. Pure.
 */

export interface PageLimits {
  /** Rows in one page before a change run is finished. */
  rows: number;
  /** UTF-16 code units of one line in a page; the whole line is asked for on its own. */
  lineLength: number;
  /** How many more rows a page may take to finish a run of changes. */
  runSlack: number;
}
export const mobilePageLimits: PageLimits = { rows: 300, lineLength: 2000, runSlack: 200 };

/** One row of a page: a line, or a fold of unchanged lines that aren't shown. */
export interface MobileRow {
  /** The row's index in the file's rows: names it for `wholeLine` and keeps order. */
  i: number;
  kind: "add" | "del" | "context" | "fold";
  old: number | null;
  new: number | null;
  /** The line without its +/-/space marker, clipped to the page's line length. */
  text: string;
  /** The whole line's length in UTF-16 code units. */
  length: number;
  clipped: boolean;
  /** A fold's unchanged lines; null when unknown (or not a fold). */
  count: number | null;
}
/** Side by side: a fold across both sides, or a line on the left (old) and right (new). */
export type MobilePair =
  | { kind: "fold"; fold: MobileRow }
  | { kind: "pair"; left: MobileRow | null; right: MobileRow | null };

const isChange = (row: DiffRow | undefined) => row?.kind === "add" || row?.kind === "del";

/**
 * Where the page starting at `start` ends, or undefined until more rows are known (`complete`
 * says no more will come). A run of changes the cut would split is finished, within the slack.
 */
export function pageEnd(
  rows: readonly DiffRow[],
  start: number,
  complete: boolean,
  limits: PageLimits = mobilePageLimits,
): number | undefined {
  let end = start + limits.rows;
  if (end >= rows.length) return complete ? rows.length : undefined;
  let slack = 0;
  while (
    end < rows.length &&
    slack < limits.runSlack &&
    isChange(rows[end - 1]) &&
    isChange(rows[end])
  ) {
    end++;
    slack++;
  }
  return end === rows.length && !complete ? undefined : end;
}

function rowOf(
  row: DiffRow,
  i: number,
  limit: number,
  clip: (text: string, limit: number) => string,
): MobileRow {
  if (row.kind === "fold")
    return {
      i,
      kind: "fold",
      old: null,
      new: null,
      text: "",
      length: 0,
      clipped: false,
      count: row.count,
    };
  return {
    i,
    kind: row.kind,
    old: row.old ?? null,
    new: row.new ?? null,
    // Every line goes through `clip`: a native one also repairs ill-formed text.
    text: clip(row.text, limit),
    length: row.text.length,
    clipped: row.text.length > limit,
    count: null,
  };
}

/** The rows `start` to `end` as one unified page. */
export function unifiedPage(
  rows: readonly DiffRow[],
  start: number,
  end: number,
  limits: PageLimits = mobilePageLimits,
  clip: (text: string, limit: number) => string = clipText,
): MobileRow[] {
  const out: MobileRow[] = [];
  for (let i = start; i < end && i < rows.length; i++) {
    const row = rows[i];
    if (row) out.push(rowOf(row, i, limits.lineLength, clip));
  }
  return out;
}

/** The rows `start` to `end` side by side, paired as the web's split view pairs them. */
export function splitPage(
  rows: readonly DiffRow[],
  start: number,
  end: number,
  limits: PageLimits = mobilePageLimits,
  clip: (text: string, limit: number) => string = clipText,
): MobilePair[] {
  const slice = rows.slice(start, end);
  const index = new Map<DiffRow, number>(slice.map((row, at) => [row, start + at]));
  const shown = (line: DiffLine | undefined) => {
    const i = line ? index.get(line) : undefined;
    return line && i !== undefined ? rowOf(line, i, limits.lineLength, clip) : null;
  };
  return pairRows(slice).map((pair): MobilePair => {
    if (pair.kind === "fold")
      return {
        kind: "fold",
        fold: rowOf(pair.row, index.get(pair.row) ?? start, limits.lineLength, clip),
      };
    return { kind: "pair", left: shown(pair.left), right: shown(pair.right) };
  });
}

/** One whole line, up to `limit` code units (lines past it say so in `clipped`). */
export function wholeLine(
  rows: readonly DiffRow[],
  i: number,
  limit: number,
  clip: (text: string, limit: number) => string = clipText,
): MobileRow | undefined {
  const row = rows[i];
  return row ? rowOf(row, i, limit, clip) : undefined;
}

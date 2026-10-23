import type { ForgePrStatus, ForgeReviewDraft } from "@ace/protocol";
import type { FileDiff } from "@ace/ui-core";

/* Where a file's comments sit on its diff. Pure; each diff is indexed once. */

type ReviewThread = ForgePrStatus["reviewThreads"][number];

/** A diff row a comment can sit under: a deleted line by its old number, any other by its new. */
export type LineKey = `${"old" | "new"}:${number}`;

/** GitHub's diff side as the diff's: LEFT is the base ("old"), RIGHT (or unknown) the head. */
export const diffSide = (side: "LEFT" | "RIGHT" | undefined): "old" | "new" =>
  side === "LEFT" ? "old" : "new";

interface DiffIndex {
  /** `old:4` / `new:7` (a line on a side) → the key of the row that draws it. */
  rowOf: ReadonlyMap<string, LineKey>;
  /** Each row's key → its position, so a range covers the rows between two positions. */
  position: ReadonlyMap<LineKey, number>;
  /** Each row's keys: its own, and for an unchanged line also its old side's (split view). */
  cells: readonly (readonly LineKey[])[];
  /** Like `rowOf`, for the lines folds hold: drawn once a fold opens, though no comment sits there. */
  foldRowOf: ReadonlyMap<string, LineKey>;
}

/** A diff line's row key: a deleted line by its old number, any other by its new one. */
function rowKey(line: {
  kind: "context" | "add" | "del";
  old?: number | undefined;
  new?: number | undefined;
}): LineKey | undefined {
  if (line.kind === "del") return line.old === undefined ? undefined : `old:${line.old}`;
  return line.new === undefined ? undefined : `new:${line.new}`;
}

/** Records under `key` the line numbers `line` has on each side it shows on. */
function addLine(
  into: Map<string, LineKey>,
  line: { kind: "context" | "add" | "del"; old?: number | undefined; new?: number | undefined },
  key: LineKey,
) {
  if (line.kind !== "add" && line.old !== undefined) into.set(`old:${line.old}`, key);
  if (line.kind !== "del" && line.new !== undefined) into.set(`new:${line.new}`, key);
}
const indexes = new WeakMap<FileDiff, DiffIndex>();

/** The diff's rows by line and by position, built once per diff (unfolded runs aren't drawn). */
function indexOf(diff: FileDiff): DiffIndex {
  const known = indexes.get(diff);
  if (known) return known;
  const rowOf = new Map<string, LineKey>();
  const foldRowOf = new Map<string, LineKey>();
  const position = new Map<LineKey, number>();
  const cells: LineKey[][] = [];
  for (const row of diff.rows) {
    if (row.kind === "fold") {
      for (const line of row.lines ?? []) {
        const key = rowKey(line);
        if (key) addLine(foldRowOf, line, key);
      }
      continue;
    }
    const key = rowKey(row);
    if (!key) continue;
    addLine(rowOf, row, key);
    position.set(key, cells.length);
    cells.push(row.kind === "context" && row.old !== undefined ? [key, `old:${row.old}`] : [key]);
  }
  const index = { rowOf, position, cells, foldRowOf };
  indexes.set(diff, index);
  return index;
}

/**
 * The row a comment on `line` of `side` hangs under. A comment on the old side of an unchanged
 * line finds that line's row. Undefined when the diff doesn't draw the line.
 */
export function lineKeyOf(diff: FileDiff, side: "old" | "new", line: number): LineKey | undefined {
  return indexOf(diff).rowOf.get(`${side}:${line}`);
}

/** Comments by the key of the line they sit under. */
export interface Placed {
  threads: ReadonlyMap<LineKey, ReviewThread[]>;
  drafts: ReadonlyMap<LineKey, ForgeReviewDraft[]>;
}

/**
 * A file's comments placed on its diff, and every row (and split-view cell) they cover. One
 * diff row holds both sides of an unchanged line, so the unified view places a comment under
 * its row, while the split view places it under the line on its own side.
 */
export interface Placement {
  unified: Placed;
  split: Placed;
  covered: ReadonlySet<LineKey>;
}

/** Most rows one comment marks; GitHub's own limit on a comment's lines is far below this. */
const maxCovered = 1_000;

/** Marks the rows from `start` to `end` in diff order; a start that isn't drawn marks `end` only. */
function cover(index: DiffIndex, covered: Set<LineKey>, start: LineKey | undefined, end: LineKey) {
  const to = index.position.get(end) ?? 0;
  const from = start === undefined ? to : (index.position.get(start) ?? to);
  const [first, last] = from <= to ? [from, to] : [to, from];
  for (let at = first; at <= Math.min(last, first + maxCovered); at++) {
    for (const key of index.cells[at] ?? []) covered.add(key);
  }
}

/**
 * Where `diff`'s current review threads and pending drafts sit: each under the row of its last
 * line (in split view, under that line on its own side), marking every row from its first
 * line, which may start on the other side. Outdated
 * threads and lines the diff doesn't draw aren't placed (`offDiffThreads` lists those threads).
 */
export function placeComments(
  diff: FileDiff,
  threads: readonly ReviewThread[],
  drafts: readonly ForgeReviewDraft[],
): Placement {
  const index = indexOf(diff);
  const unified = {
    threads: new Map<LineKey, ReviewThread[]>(),
    drafts: new Map<LineKey, ForgeReviewDraft[]>(),
  };
  const split = {
    threads: new Map<LineKey, ReviewThread[]>(),
    drafts: new Map<LineKey, ForgeReviewDraft[]>(),
  };
  const covered = new Set<LineKey>();
  const add = <T>(map: Map<LineKey, T[]>, key: LineKey, item: T) =>
    map.set(key, [...(map.get(key) ?? []), item]);
  const place = (
    side: "LEFT" | "RIGHT" | undefined,
    line: number,
    start: { side: "LEFT" | "RIGHT" | undefined; line: number } | undefined,
    put: (key: LineKey, view: "unified" | "split") => void,
  ) => {
    const own: LineKey = `${diffSide(side)}:${line}`;
    const end = index.rowOf.get(own);
    if (!end) return;
    put(end, "unified");
    put(own, "split");
    const from = start && index.rowOf.get(`${diffSide(start.side)}:${start.line}`);
    cover(index, covered, from, end);
  };
  for (const thread of threads) {
    if (thread.file !== diff.path || thread.outdated || thread.line === null) continue;
    const startLine = thread.startLine ?? undefined;
    place(
      thread.side,
      thread.line,
      startLine === undefined
        ? undefined
        : { side: thread.startSide ?? thread.side, line: startLine },
      (key, view) => add((view === "unified" ? unified : split).threads, key, thread),
    );
  }
  for (const draft of drafts) {
    const { anchor } = draft;
    if (anchor.path !== diff.path) continue;
    place(
      anchor.side,
      anchor.line,
      anchor.startLine === undefined
        ? undefined
        : { side: anchor.startSide ?? anchor.side, line: anchor.startLine },
      (key, view) => add((view === "unified" ? unified : split).drafts, key, draft),
    );
  }
  return { unified, split, covered };
}

/** Where the comment being written sits, and the lines it marks, in one view of the diff. */
export interface PickPlacement {
  end: LineKey;
  marked: ReadonlySet<LineKey>;
}

/**
 * The comment being written on `range` in `view`. Split view draws each side on its own, so
 * the pick sits on its own side's lines. Unified view draws an unchanged line once, under its
 * new number: a pick made on the old side there (in split view, or in an opened fold) moves to
 * those rows, so it never loses its place switching views.
 */
export function placePick(
  diff: FileDiff,
  range: { side: "old" | "new"; start: number; end: number },
  view: "unified" | "split",
): PickPlacement {
  const index = indexOf(diff);
  const at = (line: number): LineKey => {
    const own: LineKey = `${range.side}:${line}`;
    if (view === "split") return own;
    return index.rowOf.get(own) ?? index.foldRowOf.get(own) ?? own;
  };
  const marked = new Set<LineKey>();
  for (let line = range.start; line <= range.end; line++) marked.add(at(line));
  return { end: at(range.end), marked };
}

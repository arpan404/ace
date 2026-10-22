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
  keys: readonly LineKey[];
}
const indexes = new WeakMap<FileDiff, DiffIndex>();

/** The diff's rows by line and by position, built once per diff (unfolded runs aren't drawn). */
function indexOf(diff: FileDiff): DiffIndex {
  const known = indexes.get(diff);
  if (known) return known;
  const rowOf = new Map<string, LineKey>();
  const position = new Map<LineKey, number>();
  const keys: LineKey[] = [];
  for (const row of diff.rows) {
    if (row.kind === "fold") continue;
    const key: LineKey | undefined =
      row.kind === "del"
        ? row.old === undefined
          ? undefined
          : `old:${row.old}`
        : row.new === undefined
          ? undefined
          : `new:${row.new}`;
    if (!key) continue;
    if (row.kind !== "add" && row.old !== undefined) rowOf.set(`old:${row.old}`, key);
    if (row.kind !== "del" && row.new !== undefined) rowOf.set(`new:${row.new}`, key);
    position.set(key, keys.length);
    keys.push(key);
  }
  const index = { rowOf, position, keys };
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

/** A file's comments placed on its diff, and every row they cover. */
export interface Placement {
  threads: ReadonlyMap<LineKey, ReviewThread[]>;
  drafts: ReadonlyMap<LineKey, ForgeReviewDraft[]>;
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
    const key = index.keys[at];
    if (key) covered.add(key);
  }
}

/**
 * Where `diff`'s current review threads and pending drafts sit: each under the row of its last
 * line, marking every row from its first line, which may start on the other side. Outdated
 * threads and lines the diff doesn't draw aren't placed (`offDiffThreads` lists those threads).
 */
export function placeComments(
  diff: FileDiff,
  threads: readonly ReviewThread[],
  drafts: readonly ForgeReviewDraft[],
): Placement {
  const index = indexOf(diff);
  const placedThreads = new Map<LineKey, ReviewThread[]>();
  const placedDrafts = new Map<LineKey, ForgeReviewDraft[]>();
  const covered = new Set<LineKey>();
  for (const thread of threads) {
    if (thread.file !== diff.path || thread.outdated || thread.line === null) continue;
    const end = index.rowOf.get(`${diffSide(thread.side)}:${thread.line}`);
    if (!end) continue;
    placedThreads.set(end, [...(placedThreads.get(end) ?? []), thread]);
    const startLine = thread.startLine ?? undefined;
    const start =
      startLine === undefined
        ? undefined
        : index.rowOf.get(`${diffSide(thread.startSide ?? thread.side)}:${startLine}`);
    cover(index, covered, start, end);
  }
  for (const draft of drafts) {
    const { anchor } = draft;
    if (anchor.path !== diff.path) continue;
    const end = index.rowOf.get(`${diffSide(anchor.side)}:${anchor.line}`);
    if (!end) continue;
    placedDrafts.set(end, [...(placedDrafts.get(end) ?? []), draft]);
    const start =
      anchor.startLine === undefined
        ? undefined
        : index.rowOf.get(`${diffSide(anchor.startSide ?? anchor.side)}:${anchor.startLine}`);
    cover(index, covered, start, end);
  }
  return { threads: placedThreads, drafts: placedDrafts, covered };
}

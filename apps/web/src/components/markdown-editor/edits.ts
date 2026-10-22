/**
 * The text a Markdown field holds and what is selected in it: the input every edit reads.
 * `start` and `end` are offsets into `value`, `start <= end`.
 */
export interface Selection {
  value: string;
  start: number;
  end: number;
}

/**
 * One edit as the browser applies it: replace `from`..`to` with `insert`, then select
 * `select` (offsets in the new text). A single range replacement, so it lands as one native,
 * undoable step.
 */
export interface Change {
  from: number;
  to: number;
  insert: string;
  select: readonly [start: number, end: number];
}

/** The text after `change`, for callers and tests that need the result without a DOM. */
export function applied(value: string, change: Change): string {
  return value.slice(0, change.from) + change.insert + value.slice(change.to);
}

export function lineStart(value: string, at: number): number {
  return value.lastIndexOf("\n", at - 1) + 1;
}

export function lineEnd(value: string, at: number): number {
  const next = value.indexOf("\n", at);
  return next === -1 ? value.length : next;
}

/**
 * The whole lines a selection touches. A selection ending at the very start of a line (a
 * triple-click, or dragging to the next line's edge) leaves that line out.
 */
export function selectedLines(selection: Selection): { from: number; to: number } {
  const { value, start, end } = selection;
  const last = end > start && value[end - 1] === "\n" ? end - 1 : end;
  return { from: lineStart(value, start), to: lineEnd(value, last) };
}

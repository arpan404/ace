export type { Change, Selection } from "@ace/ui-core";
import type { Change, Selection } from "@ace/ui-core";

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

import type { EditorDocument } from "@ace/editor";
import type { Token } from "./highlighter.ts";

/*
 * A layout change (a split, a moved group, full view) unmounts a view of a document and mounts
 * another in the same commit. The leaving view hands what the person was looking at to the next
 * view of the same document: its scroll, the colours it had drawn, and the keyboard if it had it.
 * A handoff lives only until the commit is over; nothing is kept between unrelated mounts.
 */

export interface ViewHandoff {
  /** The logical line at the top edge: a narrower view may wrap it into more rows. */
  topLine: number;
  scrollLeft: number;
  /** The leaving view had the keyboard. */
  focused: boolean;
}

const handoffs = new WeakMap<EditorDocument, ViewHandoff>();

/** The colours a view of each document drew last, by line, and the version they were for. */
const drawn = new WeakMap<
  EditorDocument,
  { version: number; lines: ReadonlyMap<number, readonly Token[]> }
>();

/**
 * Keeps the colours a view just drew, so another view of the same text (a split, or the same
 * view mounted again by a layout change) draws them on its first frame instead of plain text.
 */
export function rememberColours(
  doc: EditorDocument,
  first: number,
  tokens: readonly (readonly Token[])[],
): void {
  const lines = new Map<number, readonly Token[]>();
  for (const [offset, line] of tokens.entries()) if (line.length) lines.set(first + offset, line);
  if (lines.size) drawn.set(doc, { version: doc.version(), lines });
}

/** Colours drawn for this document's current text by any view, by line; undefined when none. */
export function rememberedColours(
  doc: EditorDocument | undefined,
): ReadonlyMap<number, readonly Token[]> | undefined {
  if (!doc) return undefined;
  const entry = drawn.get(doc);
  return entry && entry.version === doc.version() ? entry.lines : undefined;
}

/** The leaving view's state, for a view of the same document mounted in this commit. */
export function leaveView(doc: EditorDocument, handoff: ViewHandoff): void {
  handoffs.set(doc, handoff);
  queueMicrotask(() => {
    if (handoffs.get(doc) === handoff) handoffs.delete(doc);
  });
}

/** What a view leaving this document just now handed over; every new view may read it. */
export function arrivingView(doc: EditorDocument | undefined): ViewHandoff | undefined {
  return doc ? handoffs.get(doc) : undefined;
}

/** The keyboard goes to one arriving view only: true for the first that asks. */
export function claimFocus(doc: EditorDocument): boolean {
  const handoff = handoffs.get(doc);
  if (!handoff?.focused) return false;
  handoffs.set(doc, { ...handoff, focused: false });
  return true;
}

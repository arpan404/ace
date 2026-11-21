import { useSyncExternalStore } from "react";

/*
 * A turn under review in the editor (docs/editor/workbench.md 43–45): Review in editor, from a
 * turn's changed files, the Work card or Changes, opens a file with that turn's hunks inline to
 * keep, revert or comment on, one after another. One review per thread, until the person ends
 * it or starts another.
 */

export interface EditorReview {
  /** The root turn's run id, as Changes scopes a turn. */
  turn: string;
  /** Tells two requests for the same turn apart, so the second starts again from the top. */
  token: number;
}

const reviews = new Map<string, EditorReview>();
const listeners = new Set<() => void>();
let tokens = 0;

const emit = () => {
  for (const listener of listeners) listener();
};

/** Review `turn` in the thread's editor. */
export function requestReview(thread: string, turn: string): void {
  reviews.set(thread, { turn, token: ++tokens });
  emit();
}

/** Done: the editor goes back to its ordinary marks. */
export function endReview(thread: string): void {
  if (!reviews.delete(thread)) return;
  emit();
}

/** The thread's review, if one is under way. */
export function useEditorReview(thread: string): EditorReview | undefined {
  return useSyncExternalStore(subscribe, () => reviews.get(thread));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

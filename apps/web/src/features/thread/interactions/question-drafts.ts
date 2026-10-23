import { useSyncExternalStore } from "react";
import { emptyDraft, type QuestionDraft } from "@ace/ui-core";

/*
 * What each open question card has been given so far, by interaction id, in memory only (a
 * secret typed on a card is never written anywhere): the card edits it, and a reply sent from
 * the composer reads it, so picks made on the card are kept. Dropped once the answer is sent.
 */

const drafts = new Map<string, QuestionDraft>();
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

export const questionDrafts = {
  get(interactionId: string): QuestionDraft {
    return drafts.get(interactionId) ?? emptyDraft;
  },
  update(interactionId: string, change: (draft: QuestionDraft) => QuestionDraft) {
    drafts.set(interactionId, change(drafts.get(interactionId) ?? emptyDraft));
    changed();
  },
  clear(interactionId: string) {
    if (drafts.delete(interactionId)) changed();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** The draft of `interactionId`'s card. */
export function useQuestionDraft(interactionId: string): QuestionDraft {
  return useSyncExternalStore(
    questionDrafts.subscribe,
    () => questionDrafts.get(interactionId),
    () => emptyDraft,
  );
}

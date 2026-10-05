import type { InteractionResolution } from "@ace/protocol";
import { useSyncExternalStore } from "react";

/*
 * Answers on their way to the daemon, by interaction id, in memory only: the card and the step
 * it gates show the pick at once ("Approved by you") and drop it if the daemon refuses it
 * (IR-2, SY-9). Kept apart from the remembered answers so step rows don't load their storage
 * schema.
 */

const picks = new Map<string, InteractionResolution>();
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

export const pendingAnswers = {
  set(interactionId: string, resolution: InteractionResolution) {
    picks.set(interactionId, resolution);
    changed();
  },
  clear(interactionId: string) {
    if (picks.delete(interactionId)) changed();
  },
  get(interactionId: string): InteractionResolution | undefined {
    return picks.get(interactionId);
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** The pick on its way for `interactionId`, if any. */
export function usePendingAnswer(interactionId: string | undefined) {
  return useSyncExternalStore(
    pendingAnswers.subscribe,
    () => (interactionId ? pendingAnswers.get(interactionId) : undefined),
    () => undefined,
  );
}

/*
 * The transcript's line for a request still waiting asks the composer's strip to bring that
 * request up and put focus on its first control. In memory, per thread: the strip listens while
 * it is mounted; with no strip listening the ask does nothing.
 */

type Listener = (interactionId: string) => void;

const listeners = new Map<string, Set<Listener>>();

/** Bring `interactionId` up in `threadId`'s strip, focused. */
export function focusRequest(threadId: string, interactionId: string): void {
  for (const listener of listeners.get(threadId) ?? []) listener(interactionId);
}

/** Listen for asks to focus a request in `threadId`'s strip. */
export function onFocusRequest(threadId: string, listener: Listener): () => void {
  let set = listeners.get(threadId);
  if (!set) listeners.set(threadId, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(threadId);
  };
}

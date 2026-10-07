import { useEffect, useRef, useSyncExternalStore } from "react";

/*
 * An agent's question answered through the composer: once the person has picked an answer on
 * the card attached to it, the composer's send button becomes Submit (or Next, while more
 * questions follow) and Enter in an empty message sends the answer. The card offers it here,
 * per thread; the composer reads it.
 */

export interface ComposerAnswer {
  /** What the send button says: "Submit", or "Next" while more questions follow. */
  label: "Submit" | "Next";
  submit(): void;
}

type Listener = () => void;
let slots: ReadonlyMap<string, ComposerAnswer> = new Map();
const listeners = new Set<Listener>();
const subscribe = (listener: Listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => slots;

function publish(threadId: string, answer: ComposerAnswer | undefined) {
  if (slots.get(threadId) === answer) return;
  const next = new Map(slots);
  if (answer) next.set(threadId, answer);
  else next.delete(threadId);
  slots = next;
  for (const listener of listeners) listener();
}

/** The answer the card above this thread's composer has ready, if any. */
export function useComposerAnswer(threadId: string): ComposerAnswer | undefined {
  return useSyncExternalStore(subscribe, snapshot, snapshot).get(threadId);
}

/**
 * Offer an answer to the composer while `label` is set (the answer is complete), withdrawn when
 * it isn't or the card goes. `submit` is read when pressed, so it may change every render.
 */
export function useOfferAnswer(
  threadId: string | undefined,
  label: ComposerAnswer["label"] | undefined,
  submit: () => void,
): void {
  const latest = useRef(submit);
  useEffect(() => {
    latest.current = submit;
  });
  useEffect(() => {
    if (!threadId || !label) return;
    const answer: ComposerAnswer = { label, submit: () => latest.current() };
    publish(threadId, answer);
    return () => {
      if (slots.get(threadId) === answer) publish(threadId, undefined);
    };
  }, [threadId, label]);
}

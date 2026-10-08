import { useEffect, useRef, useSyncExternalStore } from "react";

/*
 * An agent's question answered through the composer. The card attached to it offers its answer
 * here, per thread, and the composer's send button carries it: Answer while the message is the
 * answer (or nothing is picked yet), Submit once an option is picked, Next while more questions
 * follow. The composer says back whether its message has text, and how to put the caret in it,
 * so "Something else" can send the person there.
 */

export interface ComposerAnswer {
  label: "Answer" | "Submit" | "Next";
  /** Why it can't go yet ("Pick an answer or type one"); undefined when it can. */
  blocked: string | undefined;
  /** Sending takes the message's text as the answer, so the message empties. */
  takesText: boolean;
  /** The question accepts a typed answer: the message is where it goes. */
  invitesText: boolean;
  /** Send the answer; `text` is the message, the answer when `takesText`. */
  submit(text: string): void;
}

/** What the composer tells the card: its message has text, and how to focus it. */
export interface ComposerMessage {
  typed: boolean;
  focus(): void;
}

/** Values by thread, read with `useSyncExternalStore`. */
function threadSlots<T>() {
  let slots: ReadonlyMap<string, T> = new Map();
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const snapshot = () => slots;
  return {
    publish(threadId: string, value: T | undefined) {
      if (slots.get(threadId) === value) return;
      const next = new Map(slots);
      if (value === undefined) next.delete(threadId);
      else next.set(threadId, value);
      slots = next;
      for (const listener of listeners) listener();
    },
    get: (threadId: string) => slots.get(threadId),
    use: (threadId: string | undefined) =>
      useSyncExternalStore(subscribe, snapshot, snapshot).get(threadId ?? ""),
  };
}

const answers = threadSlots<ComposerAnswer>();
const messages = threadSlots<ComposerMessage>();

/** The answer the card above this thread's composer offers, if any. */
export function useComposerAnswer(threadId: string): ComposerAnswer | undefined {
  return answers.use(threadId);
}

/**
 * Offer an answer to the composer while the card is shown, withdrawn when it goes. `submit` is
 * read when pressed, so it may change every render.
 */
export function useOfferAnswer(
  threadId: string | undefined,
  offer: Omit<ComposerAnswer, "submit"> | undefined,
  submit: (text: string) => void,
): void {
  const latest = useRef(submit);
  useEffect(() => {
    latest.current = submit;
  });
  const label = offer?.label;
  const blocked = offer?.blocked;
  const takesText = offer?.takesText ?? false;
  const invitesText = offer?.invitesText ?? false;
  useEffect(() => {
    if (!threadId || !label) return;
    const answer: ComposerAnswer = {
      label,
      blocked,
      takesText,
      invitesText,
      submit: (text) => latest.current(text),
    };
    answers.publish(threadId, answer);
    return () => {
      if (answers.get(threadId) === answer) answers.publish(threadId, undefined);
    };
  }, [threadId, label, blocked, takesText, invitesText]);
}

/** The composer's message, as the card above it sees it. */
export function useComposerMessage(threadId: string | undefined): ComposerMessage | undefined {
  return messages.use(threadId);
}

/** The composer says whether its message has text and how to focus it, while a card asks. */
export function useShareMessage(
  threadId: string | undefined,
  typed: boolean,
  focus: () => void,
): void {
  const latest = useRef(focus);
  useEffect(() => {
    latest.current = focus;
  });
  useEffect(() => {
    if (!threadId) return;
    const message: ComposerMessage = { typed, focus: () => latest.current() };
    messages.publish(threadId, message);
    return () => {
      if (messages.get(threadId) === message) messages.publish(threadId, undefined);
    };
  }, [threadId, typed]);
}

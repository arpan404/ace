import type { MessageQuote } from "@ace/ui-core";
import { useSyncExternalStore } from "react";

/*
 * Where the two halves of replying to a passage meet for one thread: the composer holding the
 * draft's quotes, and the transcript where the person selects them. The composer publishes its
 * port while mounted; the transcript adds through it.
 */

/** The thread composer's side: where a quote of the agent's words goes. */
export interface QuotePort {
  /** Whether another quote fits in the message. */
  full: boolean;
  add(quote: MessageQuote): void;
  /** Put the caret in the composer, to write the reply. */
  focus(): void;
}

const ports = new Map<string, QuotePort>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

export function publishQuotes(threadId: string, port: QuotePort): () => void {
  ports.set(threadId, port);
  notify();
  return () => {
    if (ports.get(threadId) !== port) return;
    ports.delete(threadId);
    notify();
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The thread composer's port, while one is on screen to take a quote. */
export function useQuotePort(threadId: string): QuotePort | undefined {
  return useSyncExternalStore(subscribe, () => ports.get(threadId));
}

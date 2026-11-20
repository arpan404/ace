import { unknownFacts, type BufferFacts, type DeckBuffers } from "./buffers.ts";

/**
 * An in-memory `DeckBuffers` for the view's tests and its dev harness: facts are set by hand
 * instead of coming from W2's registry and the daemon.
 */
export interface MemoryBuffers extends DeckBuffers {
  set(path: string, facts: Partial<BufferFacts>): void;
}

const ready: BufferFacts = { ...unknownFacts, load: { state: "ready" } };

export function memoryBuffers(initial: Record<string, Partial<BufferFacts>> = {}): MemoryBuffers {
  const facts = new Map<string, BufferFacts>(
    Object.entries(initial).map(([path, partial]) => [path, { ...ready, ...partial }]),
  );
  const listeners = new Set<() => void>();
  return {
    facts: (path) => {
      const known = facts.get(path);
      if (known) return known;
      facts.set(path, ready);
      return ready;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (path, partial) => {
      facts.set(path, { ...(facts.get(path) ?? ready), ...partial });
      for (const listener of listeners) listener();
    },
  };
}

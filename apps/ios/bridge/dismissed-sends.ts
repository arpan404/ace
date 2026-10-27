import { z } from "zod";

/*
 * Failed sends the person has dealt with on this phone: Edit took the words back into the
 * composer, or Discard dropped them. The SDK's outbox keeps failed sends for a while, across
 * launches too, so the choice is kept in the machine's own store (as the web keeps it per
 * browser). Newest 200 kept.
 */

const limit = 200;
const Kept = z.array(z.string().min(1).max(256)).max(limit);

export interface DismissedSends {
  has(commandId: string): boolean;
  dismiss(commandId: string): void;
  /** Undo of a Discard: the failed send shows again. */
  restore(commandId: string): void;
  /** Called with the command id each time one is dismissed or restored, and once the kept list loads. */
  observe(listener: (commandId: string | undefined) => void): () => void;
}

export function followDismissed(native: {
  load(): Promise<string>;
  save(value: string): Promise<void>;
}): DismissedSends {
  let ids: string[] = [];
  const listeners = new Set<(commandId: string | undefined) => void>();
  const changed = (commandId: string | undefined) => {
    for (const listener of listeners) listener(commandId);
  };
  const save = () => void native.save(JSON.stringify(ids)).catch(() => {});
  void native
    .load()
    .then((text) => {
      let raw: unknown;
      try {
        raw = text ? JSON.parse(text) : [];
      } catch {
        raw = [];
      }
      const parsed = Kept.safeParse(raw);
      // A dismissal made while loading stays, after what was kept.
      if (parsed.success) ids = [...new Set([...parsed.data, ...ids])].slice(-limit);
      changed(undefined);
    })
    .catch(() => {});
  return {
    has: (commandId) => ids.includes(commandId),
    dismiss(commandId) {
      if (ids.includes(commandId)) return;
      ids = [...ids, commandId].slice(-limit);
      save();
      changed(commandId);
    },
    restore(commandId) {
      if (!ids.includes(commandId)) return;
      ids = ids.filter((id) => id !== commandId);
      save();
      changed(commandId);
    },
    observe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Nothing kept: a runtime without the store (tests, older hosts). */
export const keepNone: DismissedSends = {
  has: () => false,
  dismiss: () => {},
  restore: () => {},
  observe: () => () => {},
};

import { z } from "zod";

/*
 * Failed sends the person has dealt with on this phone: Edit took the words back into the
 * composer, or Discard dropped them. The SDK's outbox keeps failed sends for a while, across
 * launches too, so the choice is kept in the machine's own store (as the web keeps it per
 * browser). Newest 200 kept.
 *
 * Loading and every change run one after another: a change made while the kept list still loads
 * waits for it, so it is saved on top of what was kept, never over it. A change counts only once
 * its save has committed; a failed save leaves the list as it was.
 */

const limit = 200;
const Kept = z.array(z.string().min(1).max(256)).max(limit);

export interface DismissedSends {
  has(commandId: string): boolean;
  /** Resolves true once the dismissal is saved; false (and nothing changed) when it couldn't be. */
  dismiss(commandId: string): Promise<boolean>;
  /** Undo of a Discard: the failed send shows again. */
  restore(commandId: string): Promise<boolean>;
  /** Called with the command id each time one is dismissed or restored, and once the kept list loads. */
  observe(listener: (commandId: string | undefined) => void): () => void;
}

function parse(text: string): string[] {
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : [];
  } catch {
    raw = [];
  }
  return Kept.safeParse(raw).data ?? [];
}

export function followDismissed(native: {
  load(): Promise<string>;
  save(value: string): Promise<void>;
}): DismissedSends {
  let ids: readonly string[] = [];
  const listeners = new Set<(commandId: string | undefined) => void>();
  const changed = (commandId: string | undefined) => {
    for (const listener of listeners) listener(commandId);
  };
  // Every change queues behind the load and the changes before it.
  let turn: Promise<unknown> = native
    .load()
    .then((text) => {
      ids = parse(text);
      changed(undefined);
    })
    .catch(() => {});
  const change = (commandId: string, next: (current: readonly string[]) => readonly string[]) => {
    const run = turn.then(async () => {
      const updated = next(ids);
      if (updated === ids) return true;
      try {
        await native.save(JSON.stringify(updated));
      } catch {
        return false;
      }
      ids = updated;
      changed(commandId);
      return true;
    });
    turn = run;
    return run;
  };
  return {
    has: (commandId) => ids.includes(commandId),
    dismiss: (commandId) =>
      change(commandId, (current) =>
        current.includes(commandId) ? current : [...current, commandId].slice(-limit),
      ),
    restore: (commandId) =>
      change(commandId, (current) =>
        current.includes(commandId) ? current.filter((id) => id !== commandId) : current,
      ),
    observe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Nothing kept: a runtime without the store (tests, older hosts). */
export const keepNone: DismissedSends = {
  has: () => false,
  dismiss: async () => false,
  restore: async () => false,
  observe: () => () => {},
};

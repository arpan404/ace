import * as z from "zod/mini";
import type { TerminalEnd } from "./closing.ts";

export type TerminalCloseStorage = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;
const prefix = "ace.terminal-close.v1:";
/** Refuse further closes at the limit; never evict an unacknowledged close. */
export const terminalCloseCapacity = 512;
const SavedEnd = z.object({
  hostId: z.string().check(z.minLength(1), z.maxLength(128)),
  threadId: z.string().check(z.minLength(1), z.maxLength(128)),
  terminalId: z.string().check(z.minLength(1), z.maxLength(128)),
});
const keyOf = (hostId: string, end: TerminalEnd) =>
  prefix + JSON.stringify([hostId, end.threadId, end.terminalId]);

/** One synchronous record per close, so saving another tab cannot replace an earlier intent. */
export function createTerminalEndJournal(
  readStorage: () => TerminalCloseStorage,
  capacity = terminalCloseCapacity,
) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > terminalCloseCapacity)
    throw new Error("invalid_terminal_close_capacity");
  return {
    save(hostId: string, end: TerminalEnd): void {
      const saved = SavedEnd.parse({ hostId, ...end });
      const storage = readStorage();
      const key = keyOf(hostId, end);
      const encoded = JSON.stringify(saved);
      const previous = storage.getItem(key);
      if (previous === encoded) return;
      if (previous !== null) {
        storage.setItem(key, encoded);
        return;
      }
      let count = 0;
      for (let index = 0; index < storage.length; index++) {
        if (storage.key(index)?.startsWith(prefix)) count++;
        if (count >= capacity) throw new Error("terminal_close_queue_full");
      }
      // Quota/access failures propagate: the tab must remain until this write succeeds.
      storage.setItem(key, encoded);
    },
    load(hostId: string): TerminalEnd[] {
      const storage = readStorage();
      const found: TerminalEnd[] = [];
      for (let index = 0; index < storage.length && found.length < capacity; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(prefix)) continue;
        const raw = storage.getItem(key);
        if (raw === null || raw.length > 4096) continue;
        try {
          const saved = SavedEnd.safeParse(JSON.parse(raw));
          if (saved.success && saved.data.hostId === hostId && key === keyOf(hostId, saved.data))
            found.push({ threadId: saved.data.threadId, terminalId: saved.data.terminalId });
        } catch {
          // Invalid records cannot authorize closing a shell and are never silently overwritten.
        }
      }
      return found;
    },
    retire(hostId: string, end: TerminalEnd): void {
      readStorage().removeItem(keyOf(hostId, end));
    },
  };
}
export type TerminalEndJournal = ReturnType<typeof createTerminalEndJournal>;

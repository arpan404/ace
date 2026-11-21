import { useSyncExternalStore } from "react";
import type { AddressedShare } from "@ace/protocol";

/*
 * Whether a thread's next message to bots and clubs takes the thread's context pack or only its
 * words (ADR 0198): the person's choice on the composer's "Shares" line, kept per thread while
 * the window is open. Sending takes the choice and the next message starts from sharing again.
 */

const chosen = new Map<string, AddressedShare>();
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function shareChoice(threadId: string): AddressedShare {
  return chosen.get(threadId) ?? "thread";
}
export function chooseShare(threadId: string, share: AddressedShare): void {
  if (share === "thread") chosen.delete(threadId);
  else chosen.set(threadId, share);
  changed();
}
export function useShareChoice(threadId: string): AddressedShare {
  return useSyncExternalStore(subscribe, () => shareChoice(threadId));
}

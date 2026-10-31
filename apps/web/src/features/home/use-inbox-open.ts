import { useSyncExternalStore } from "react";
import { useLayoutServices, type SessionKey } from "@/lib/layout.tsx";

/*
 * Whether the Threads panel's Inbox overlay is open. One per app window, in memory: the bell
 * and ⌘I (bound app-wide) share it, and a reload starts closed.
 */

export class InboxOpen {
  private value = false;
  private listeners = new Set<() => void>();
  get = (): boolean => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set = (value: boolean): void => {
    if (value === this.value) return;
    this.value = value;
    for (const listener of this.listeners) listener();
  };
  toggle = (): void => this.set(!this.value);
}

const inboxKey: SessionKey<InboxOpen> = { name: "home-inbox-open" };

/** The window's Inbox state, to open, close or toggle it. */
export function useInboxStore(): InboxOpen {
  return useLayoutServices().sessionValue(inboxKey, () => new InboxOpen());
}

/** Whether the Inbox overlay is open now. */
export function useInboxOpen(): boolean {
  const store = useInboxStore();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

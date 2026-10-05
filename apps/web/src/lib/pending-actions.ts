import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import type { OrganizePatch } from "@ace/ui-core";
import { useSyncExternalStore } from "react";

/*
 * Organize actions this window has made that the daemon hasn't confirmed yet (UX audit SY-10).
 * The organize feature adds them and takes them away; the shell's offline notice lists the ones
 * still waiting. Only the list lives here, below both, so the notice stays small.
 */

/** One organize action shown before the daemon has confirmed it. */
export interface PendingAction {
  key: number;
  threadId: string;
  patch: OrganizePatch;
  /** When it was taken, on this device's clock. */
  at: number;
  /** "Archive · Fix the flaky test", for the list of what waits for the daemon. */
  label: string;
  /** Saved but without the daemon's receipt yet. */
  waiting: boolean;
}

const none: readonly PendingAction[] = [];

/** The pending actions, all and per thread, each list a new array only when it changes. */
export class PendingActions {
  private list: readonly PendingAction[] = none;
  private byThread = new Map<string, readonly PendingAction[]>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** Every pending action, oldest first. */
  all = (): readonly PendingAction[] => this.list;
  /** One thread's pending actions, oldest first. */
  forThread(threadId: string): readonly PendingAction[] {
    return this.byThread.get(threadId) ?? none;
  }
  add(action: PendingAction): void {
    this.set([...this.list, action], action.threadId);
  }
  replace(action: PendingAction): void {
    this.set(
      this.list.map((pending) => (pending.key === action.key ? action : pending)),
      action.threadId,
    );
  }
  remove(action: PendingAction): void {
    this.set(
      this.list.filter((pending) => pending.key !== action.key),
      action.threadId,
    );
  }
  private set(list: readonly PendingAction[], threadId: string): void {
    this.list = list;
    const own = list.filter((action) => action.threadId === threadId);
    if (own.length) this.byThread.set(threadId, own);
    else this.byThread.delete(threadId);
    for (const listener of this.listeners) listener();
  }
}

const stores = new WeakMap<ClientApi, PendingActions>();

/** The pending actions of one client: every view in this window shares them. */
export function pendingActionsOf(client: ClientApi): PendingActions {
  let store = stores.get(client);
  if (!store) {
    store = new PendingActions();
    stores.set(client, store);
  }
  return store;
}

/** Every pending organize action, oldest first. */
export function usePendingActions(): readonly PendingAction[] {
  const store = pendingActionsOf(useClient());
  return useSyncExternalStore(store.subscribe, store.all, store.all);
}

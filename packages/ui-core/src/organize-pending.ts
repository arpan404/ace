import type { SidebarSource } from "@ace/client";
import type { ThreadListEntry } from "@ace/protocol";
import type { Timers } from "./held-order.ts";
import { patchedEntry, reflects, type OrganizePatch } from "./organize-patch.ts";

/*
 * Organize actions a client has made that the daemon hasn't confirmed yet (UX audit SY-10),
 * shared by the web's Home list and the phone's inbox. Each shows on its thread's list entry at
 * once (`patchedEntry`) and goes when the daemon's entry shows it, or a little after its
 * receipt should another device have changed the thread again, or at once when it can't be
 * saved or the daemon refuses it. Offline it stays until the outbox delivers it.
 */

/** After its receipt, how long an action waits at most for the list to show it. */
export const organizeSettleMs = 5_000;

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
  private listeners = new Set<(threadId: string) => void>();
  private count = 0;
  /** Hear each change, with the thread it changed. */
  subscribe = (listener: (threadId: string) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  /** Every pending action, oldest first. */
  all = (): readonly PendingAction[] => this.list;
  /** One thread's pending actions, oldest first. */
  forThread(threadId: string): readonly PendingAction[] {
    return this.byThread.get(threadId) ?? none;
  }
  /** `entry` as it shows here, with its pending actions applied. */
  apply(entry: ThreadListEntry): ThreadListEntry {
    const pending = this.forThread(entry.id);
    return pending.length ? patchedEntry(entry, pending) : entry;
  }
  /** A key no other action of this list holds. */
  nextKey(): number {
    return ++this.count;
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
    if (!this.list.some((pending) => pending.key === action.key)) return;
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
    for (const listener of this.listeners) listener(threadId);
  }
}

/** Resolves when the list shows `patch` on the thread, or after `settleMs` regardless. */
export function whenShown(
  store: Pick<SidebarSource, "select">,
  threadId: string,
  patch: OrganizePatch,
  before: ThreadListEntry | undefined,
  timers: Timers,
  settleMs = organizeSettleMs,
): Promise<void> {
  return new Promise((resolve) => {
    const selection = store.select([`thread:${threadId}`, "ids"], (reader) =>
      reflects(reader.thread(threadId), patch, before),
    );
    let finished = false;
    let unsubscribe: (() => void) | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      unsubscribe?.();
      cancel();
      resolve();
    };
    const cancel = timers.set(settleMs, finish);
    unsubscribe = selection.subscribe(() => {
      if (selection.getSnapshot()) finish();
    });
    if (selection.getSnapshot()) finish();
  });
}

/**
 * Show `action` now and run `send`, which resolves once the daemon accepted it and rejects when
 * it was refused or couldn't be saved. Resolves once the list shows it; rejects with `send`'s
 * error, the change already undone, when refused.
 */
export async function runOrganize(
  pending: PendingActions,
  store: Pick<SidebarSource, "select" | "thread">,
  timers: Timers,
  action: PendingAction,
  send: () => Promise<unknown>,
): Promise<void> {
  const before = store.thread(action.threadId);
  pending.add(action);
  try {
    await send();
  } catch (error) {
    pending.remove(action);
    throw error;
  }
  pending.replace({ ...action, waiting: false });
  await whenShown(store, action.threadId, action.patch, before, timers);
  pending.remove(action);
}

// TODO(train-2): wire to protocol when merged. Only `thread.archive` is a daemon command on
// main; rename, fork, settle, snooze, delete and removing a queued message are not.
import type { ThreadRef } from "./workspace-source.ts";

export type SnoozeUntil = "1 hour" | "Tomorrow 9:00" | "Next Monday";

export interface ThreadActionsSource {
  rename(thread: ThreadRef, title: string): Promise<void>;
  /** Returns the new thread's id. */
  fork(thread: ThreadRef): Promise<string>;
  settle(thread: ThreadRef): Promise<void>;
  snooze(thread: ThreadRef, until: SnoozeUntil): Promise<void>;
  remove(thread: ThreadRef): Promise<void>;
  restore(thread: ThreadRef): Promise<void>;
  /** Withdraw a message that is waiting for the agent to be free. */
  unqueue(thread: ThreadRef, intentId: string): Promise<void>;
  /** Titles renamed here, until the daemon reports renames itself. */
  title(threadId: string): string | undefined;
  subscribe(changed: () => void): () => void;
}

export function fakeThreadActionsSource(): ThreadActionsSource {
  const titles = new Map<string, string>();
  const listeners = new Set<() => void>();
  let forks = 0;
  return {
    rename: (thread, title) => {
      titles.set(thread.id, title);
      for (const listener of listeners) listener();
      return Promise.resolve();
    },
    fork: (thread) => Promise.resolve(`${thread.id}-fork-${++forks}`),
    settle: () => Promise.resolve(),
    snooze: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    restore: () => Promise.resolve(),
    unqueue: () => Promise.resolve(),
    title: (threadId) => titles.get(threadId),
    subscribe: (changed) => {
      listeners.add(changed);
      return () => listeners.delete(changed);
    },
  };
}

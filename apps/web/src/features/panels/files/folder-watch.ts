import type { ClientApi } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { watchedFolders } from "@ace/ui-core";

/** How long a change in what is on screen waits before `files.watch` names it. */
export const watchDelay = 150;

type Send = Pick<ClientApi, "send">;

/** Hears the folders the daemon now watches for the thread, each time a set reaches it. */
export type Watched = (folders: readonly string[]) => void;

interface ThreadWatch {
  /** Each mounted tree's visible open folders, by tree id. */
  trees: Map<number, readonly string[]>;
  /** Trees that want to hear once the daemon has their set, by tree id. */
  listeners: Map<number, Watched>;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The folders last sent, joined; undefined when the daemon's set is unknown (a reconnect). */
  sent: string | undefined;
}

/** One watch registry per client, one set per thread. */
const registries = new WeakMap<Send, Map<string, ThreadWatch>>();
let nextTree = 0;

export interface FolderWatchHandle {
  /**
   * What this tree shows open; the thread watches the union of every mounted tree's set. Once
   * the union reaches the daemon (or already had), the handle's `onWatched` hears it.
   */
  set(folders: Iterable<string>): void;
  /** After a reconnect: send the union again, even when it hasn't changed. */
  resume(): void;
  /** This tree is gone; the thread's last one stops watching with an empty set. */
  leave(): void;
}

/**
 * The `files.watch` sets of one thread: a tree adds the folders it shows open, and the daemon
 * hears one debounced union for the thread, however many trees show it. The last tree to leave
 * sends `[]`; before that, leaving only narrows the union.
 */
export function watchFolders(
  client: Send,
  threadId: string,
  onWatched?: Watched,
): FolderWatchHandle {
  const id = ++nextTree;
  // The thread's set is looked up on every call, never held: after the last tree leaves, its set
  // is gone, and a handle used again (a hidden tab shown again) joins whichever set the thread
  // has now instead of sending a second, competing replacement set of its own.
  const current = (): ThreadWatch => {
    let registry = registries.get(client);
    if (!registry) {
      registry = new Map();
      registries.set(client, registry);
    }
    let watch = registry.get(threadId);
    if (!watch) {
      watch = { trees: new Map(), listeners: new Map(), timer: undefined, sent: undefined };
      registry.set(threadId, watch);
    }
    return watch;
  };
  const send = (thread: ThreadWatch, folders: string[]): boolean => {
    const key = folders.join("\0");
    try {
      client.send({ type: "files.watch", threadId: ThreadId.parse(threadId), folders });
      thread.sent = key;
      return true;
    } catch {
      // Offline: the set is unknown to the daemon until the next resume sends it.
      thread.sent = undefined;
      return false;
    }
  };
  const schedule = (thread: ThreadWatch) => {
    if (thread.timer !== undefined) return;
    thread.timer = setTimeout(() => {
      thread.timer = undefined;
      const folders = watchedFolders([...thread.trees.values()].flat());
      if (folders.join("\0") !== thread.sent && !send(thread, folders)) return;
      for (const listener of thread.listeners.values()) listener(folders);
    }, watchDelay);
  };
  return {
    set(folders) {
      const thread = current();
      thread.trees.set(id, [...folders]);
      if (onWatched) thread.listeners.set(id, onWatched);
      schedule(thread);
    },
    resume() {
      const thread = current();
      thread.sent = undefined;
      schedule(thread);
    },
    leave() {
      const registry = registries.get(client);
      const thread = registry?.get(threadId);
      thread?.listeners.delete(id);
      if (!registry || !thread || !thread.trees.delete(id)) return;
      if (thread.trees.size > 0) {
        schedule(thread);
        return;
      }
      if (thread.timer !== undefined) {
        clearTimeout(thread.timer);
        thread.timer = undefined;
      }
      send(thread, []);
      registry.delete(threadId);
    },
  };
}

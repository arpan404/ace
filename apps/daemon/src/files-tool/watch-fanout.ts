import type { EventPayload } from "@ace/files-native";
import type { ThreadId } from "@ace/protocol";

/** Timers, injected so a test decides when a coalescing window closes. */
export type WatchClock = { setTimeout(callback: () => void, ms: number): () => void };

/** One push: the folders of one thread whose contents changed, or a whole re-list. */
export type FoldersUpdate = { threadId: ThreadId; folders: string[]; rescan: boolean };

export type WatchFanoutOptions = {
  clock: WatchClock;
  /** The client's own push channel; a closed socket is the caller's to drop. */
  send(clientId: string, update: FoldersUpdate): void;
  /** Coalescing window per client and thread; the plan's 100 ms. */
  windowMs?: number;
};

/** What a batch makes stale, in the same terms a client watches. */
export type ChangedFolders = { folders: Set<string>; rescan: boolean };

/** The plan's per-client cap; larger sets keep their first folders. */
export const maxWatchedFolders = 512;
/** The plan's floor between two pushes to one client for one thread. */
export const foldersChangedWindowMs = 100;

type ThreadWatch = {
  root: string;
  folders: Set<string>;
  pending: Set<string>;
  rescan: boolean;
  cancel?: (() => void) | undefined;
};

/** The folders a batch makes stale: the folder each path sits in, and a changed folder itself. */
export function changedFolders(payload: EventPayload): ChangedFolders {
  if (payload.type === "rescan") return { folders: new Set(), rescan: true };
  const folders = new Set<string>();
  if (payload.type !== "changes") return { folders, rescan: false };
  for (const change of payload.changes) {
    const slash = change.path.lastIndexOf("/");
    folders.add(slash < 0 ? "" : change.path.slice(0, slash));
    if (change.directory) folders.add(change.path);
  }
  return { folders, rescan: false };
}

/** Root-relative folder names as a client watches them: no `./`, no trailing slash. */
export function normalizeFolders(folders: readonly string[]): Set<string> {
  const normalized = new Set<string>();
  for (const folder of folders) {
    if (normalized.size >= maxWatchedFolders) break;
    const trimmed = folder.replace(/\/+$/, "").replace(/^\.\/+/, "");
    normalized.add(trimmed === "." ? "" : trimmed);
  }
  return normalized;
}

/** How one client's watch of one thread is filed. */
export function watchKey(clientId: string, threadId: ThreadId): string {
  return `${clientId}\u0000${threadId}`;
}

/**
 * Turns one root's change batches into per-client folder pushes: each batch names the folders it
 * makes stale, each client hears only the folders in its own set for that thread, and everything a
 * client accumulates inside one window leaves as a single message. Pure but for the injected
 * timers, so the fan-out is tested without a process or a socket.
 */
export class WatchFanout {
  readonly #clock: WatchClock;
  readonly #send: (clientId: string, update: FoldersUpdate) => void;
  readonly #windowMs: number;
  readonly #watches = new Map<string, Map<ThreadId, ThreadWatch>>();

  constructor(options: WatchFanoutOptions) {
    this.#clock = options.clock;
    this.#send = options.send;
    this.#windowMs = options.windowMs ?? foldersChangedWindowMs;
  }

  /** Replace one client's folders for a thread; an empty list stops watching it. */
  watch(clientId: string, threadId: ThreadId, root: string, folders: readonly string[]): void {
    const set = normalizeFolders(folders);
    if (!set.size) {
      this.stop(clientId, threadId);
      return;
    }
    let threads = this.#watches.get(clientId);
    if (!threads) {
      threads = new Map();
      this.#watches.set(clientId, threads);
    }
    const existing = threads.get(threadId);
    if (existing) {
      existing.cancel?.();
      existing.cancel = undefined;
      existing.root = root;
      existing.folders = set;
      // The client is re-listing anyway; what was pending for the old set is moot.
      existing.pending.clear();
      existing.rescan = false;
      return;
    }
    threads.set(threadId, { root, folders: set, pending: new Set(), rescan: false });
  }

  /** Stop watching one thread; nothing more is pushed for it. */
  stop(clientId: string, threadId: ThreadId): void {
    const threads = this.#watches.get(clientId);
    const watch = threads?.get(threadId);
    if (!threads || !watch) return;
    watch.cancel?.();
    threads.delete(threadId);
    if (!threads.size) this.#watches.delete(clientId);
  }

  /** The client's socket closed: drop its sets and pending windows. */
  disconnect(clientId: string): void {
    const threads = this.#watches.get(clientId);
    if (!threads) return;
    for (const watch of threads.values()) watch.cancel?.();
    this.#watches.delete(clientId);
  }

  /** One batch from the root's watch; schedules each affected client's next push. */
  batch(root: string, payload: EventPayload): void {
    const changed = changedFolders(payload);
    if (!changed.rescan && !changed.folders.size) return;
    for (const [clientId, threads] of this.#watches) {
      for (const [threadId, watch] of threads) {
        if (watch.root !== root) continue;
        if (changed.rescan) {
          watch.rescan = true;
        } else {
          const matched = [...changed.folders].filter((folder) => watch.folders.has(folder));
          if (!matched.length) continue;
          for (const folder of matched) watch.pending.add(folder);
        }
        this.#schedule(clientId, threadId, watch);
      }
    }
  }

  #schedule(clientId: string, threadId: ThreadId, watch: ThreadWatch): void {
    if (watch.cancel) return;
    watch.cancel = this.#clock.setTimeout(() => {
      watch.cancel = undefined;
      this.#flush(clientId, threadId, watch);
    }, this.#windowMs);
  }

  #flush(clientId: string, threadId: ThreadId, watch: ThreadWatch): void {
    const rescan = watch.rescan;
    const folders = rescan ? [...watch.folders] : [...watch.pending];
    watch.rescan = false;
    watch.pending.clear();
    if (!folders.length) return;
    this.#send(clientId, { threadId, folders: folders.toSorted(), rescan });
  }
}

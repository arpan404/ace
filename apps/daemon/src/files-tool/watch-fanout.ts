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
/** One client watches at most this many threads; the oldest makes room for a new one. */
export const maxWatchedThreads = 8;
/** Evicted threads remembered per client, so re-watching one asks for a re-list. */
const maxEvictedThreads = 32;

type ThreadWatch = {
  root: string;
  folders: Set<string>;
  pending: Set<string>;
  rescan: boolean;
  cancel?: (() => void) | undefined;
};

type Evicted = { threadId: ThreadId; root: string };

/**
 * The folders a batch makes stale: the folder each path sits in, and a changed folder itself,
 * because its own listing changed too. A rescan says to re-list everything, and so does a watcher
 * warning: the native watcher fell back to polling or lost track of the tree, and one message a
 * client may have missed is one folder it must list again.
 */
export function changedFolders(payload: EventPayload): ChangedFolders {
  if (payload.type === "rescan") return { folders: new Set(), rescan: true };
  if (payload.type === "warning") return { folders: new Set(), rescan: true };
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

/**
 * Turns one root's change batches into per-client folder pushes: each batch names the folders it
 * makes stale, each client hears only the folders in its own set for that thread, and everything a
 * client accumulates inside one window leaves as a single message. Watches are indexed by root, so
 * a batch only walks that checkout's watchers, and a client's oldest thread gives way when it asks
 * for a ninth. Pure but for the injected timers.
 */
export class WatchFanout {
  readonly #clock: WatchClock;
  readonly #send: (clientId: string, update: FoldersUpdate) => void;
  readonly #windowMs: number;
  /** root -> client -> thread; a batch reads only its own root's entry. */
  readonly #byRoot = new Map<string, Map<string, Map<ThreadId, ThreadWatch>>>();
  /** client -> thread -> root and watch, oldest first, for the per-client cap. */
  readonly #byClient = new Map<string, Map<ThreadId, { root: string; watch: ThreadWatch }>>();
  /** client -> threads evicted to make room, so re-watching one starts with a rescan. */
  readonly #evicted = new Map<string, Set<ThreadId>>();

  constructor(options: WatchFanoutOptions) {
    this.#clock = options.clock;
    this.#send = options.send;
    this.#windowMs = options.windowMs ?? foldersChangedWindowMs;
  }

  /**
   * Replace one client's folders for a thread; an empty list stops watching it. Returns the thread
   * evicted to keep the client under its cap, whose caller drops the root it held.
   */
  watch(
    clientId: string,
    threadId: ThreadId,
    root: string,
    folders: readonly string[],
  ): Evicted | undefined {
    const set = normalizeFolders(folders);
    if (!set.size) {
      this.stop(clientId, threadId);
      return undefined;
    }
    let threads = this.#byClient.get(clientId);
    if (!threads) {
      threads = new Map();
      this.#byClient.set(clientId, threads);
    }
    const existing = threads.get(threadId);
    if (existing) {
      if (existing.root === root) {
        // The client is re-listing its new set, but changes already pending for folders it still
        // watches are real news it has not heard yet: keep them, and keep the flush that carries
        // them. Only what the new set no longer watches is dropped.
        for (const folder of existing.watch.pending) {
          if (!set.has(folder)) existing.watch.pending.delete(folder);
        }
        existing.watch.folders = set;
        if (existing.watch.rescan || existing.watch.pending.size) {
          this.#schedule(clientId, threadId, existing.watch);
        }
      } else {
        // Another checkout: what was pending for the old tree says nothing about the new one.
        existing.watch.cancel?.();
        existing.watch.cancel = undefined;
        existing.watch.pending.clear();
        existing.watch.rescan = false;
        existing.watch.folders = set;
        this.#unindex(existing.root, clientId, threadId);
        existing.root = root;
        existing.watch.root = root;
        this.#index(root, clientId, threadId, existing.watch);
      }
      // A thread watched again is the most recently used of the client's set.
      threads.delete(threadId);
      threads.set(threadId, existing);
      return undefined;
    }
    let evicted: Evicted | undefined;
    if (threads.size >= maxWatchedThreads) {
      const oldest = threads.entries().next().value;
      if (oldest) {
        evicted = { threadId: oldest[0], root: oldest[1].root };
        this.#forget(clientId, oldest[0]);
      }
    }
    const missed = this.#evicted.get(clientId);
    const watch: ThreadWatch = {
      root,
      folders: set,
      pending: new Set(),
      rescan: missed?.delete(threadId) === true,
    };
    threads.set(threadId, { root, watch });
    this.#index(root, clientId, threadId, watch);
    // A thread re-watched after eviction may have changed while nobody was listening.
    if (watch.rescan) this.#schedule(clientId, threadId, watch);
    return evicted;
  }

  /** Stop watching one thread; nothing more is pushed for it. */
  stop(clientId: string, threadId: ThreadId): void {
    this.#forget(clientId, threadId);
  }

  /** The client's socket closed: drop its sets and pending windows. */
  disconnect(clientId: string): void {
    const threads = this.#byClient.get(clientId);
    if (!threads) return;
    for (const threadId of threads.keys()) this.#forget(clientId, threadId);
    this.#evicted.delete(clientId);
  }

  /** Every folder any client watches on a root, sorted, at most the per-client cap. */
  openFolders(root: string): string[] {
    const open = new Set<string>();
    for (const threads of this.#byRoot.get(root)?.values() ?? []) {
      for (const watch of threads.values()) for (const folder of watch.folders) open.add(folder);
    }
    return [...open].toSorted().slice(0, maxWatchedFolders);
  }

  /** The folders one client watches for one thread, sorted, for a re-list after a stale root. */
  folders(clientId: string, threadId: ThreadId): string[] {
    const watch = this.#byClient.get(clientId)?.get(threadId)?.watch;
    return watch ? [...watch.folders].toSorted() : [];
  }

  /** One batch from the root's watch; only that root's watchers are looked at. */
  batch(root: string, payload: EventPayload): void {
    const changed = changedFolders(payload);
    if (!changed.rescan && !changed.folders.size) return;
    const clients = this.#byRoot.get(root);
    if (!clients) return;
    for (const [clientId, threads] of clients) {
      for (const [threadId, watch] of threads) {
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
    if (this.#byClient.get(clientId)?.get(threadId)?.watch !== watch) return;
    const rescan = watch.rescan;
    const folders = rescan ? [...watch.folders] : [...watch.pending];
    watch.rescan = false;
    watch.pending.clear();
    if (!folders.length) return;
    this.#send(clientId, { threadId, folders: folders.toSorted(), rescan });
  }

  #index(root: string, clientId: string, threadId: ThreadId, watch: ThreadWatch): void {
    let clients = this.#byRoot.get(root);
    if (!clients) {
      clients = new Map();
      this.#byRoot.set(root, clients);
    }
    let threads = clients.get(clientId);
    if (!threads) {
      threads = new Map();
      clients.set(clientId, threads);
    }
    threads.set(threadId, watch);
  }

  #unindex(root: string, clientId: string, threadId: ThreadId): void {
    const clients = this.#byRoot.get(root);
    const threads = clients?.get(clientId);
    if (!clients || !threads) return;
    threads.delete(threadId);
    if (!threads.size) clients.delete(clientId);
    if (!clients.size) this.#byRoot.delete(root);
  }

  /** Drop a thread's watch, remembering it so a re-watch asks for a re-list. */
  #forget(clientId: string, threadId: ThreadId): void {
    const threads = this.#byClient.get(clientId);
    const entry = threads?.get(threadId);
    if (!threads || !entry) return;
    entry.watch.cancel?.();
    this.#unindex(entry.root, clientId, threadId);
    threads.delete(threadId);
    if (!threads.size) this.#byClient.delete(clientId);
    let evicted = this.#evicted.get(clientId);
    if (!evicted) {
      evicted = new Set();
      this.#evicted.set(clientId, evicted);
    }
    evicted.add(threadId);
    while (evicted.size > maxEvictedThreads) {
      const oldest = evicted.values().next().value;
      if (oldest === undefined) break;
      evicted.delete(oldest);
    }
  }
}

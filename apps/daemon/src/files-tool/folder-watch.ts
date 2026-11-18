import type { EventPayload } from "@ace/files-native";
import type { FilesServerMessage, ThreadId } from "@ace/protocol";
import { WatchFanout, type FoldersUpdate, type WatchClock } from "./watch-fanout.ts";

/** The push a watching client receives: folders of one thread whose contents changed. */
export type FoldersChanged = Extract<FilesServerMessage, { type: "files.folders_changed" }>;

/** A socket that asked to watch folders, and how to tell it about them later. */
export type FolderWatchClient = {
  id: string;
  /** The socket may still receive pushes at all: connected and read-authorized. */
  sendable(): boolean;
  /** This thread is live, readable, and still runs on the checkout the watch was taken on. */
  valid(thread: { id: ThreadId; root: string }): boolean;
  send(message: FoldersChanged): void;
};

/** What the book needs from ace-files: one shared watch per checkout. */
export type FolderWatchPorts = {
  watch(path: string, onBatch: (payload: EventPayload) => void): Promise<() => Promise<void>>;
};

export type FolderWatchOptions = {
  clock: WatchClock;
  /** Coalescing window per client and thread; the plan's 100 ms. */
  windowMs?: number | undefined;
};

type RootSubscription = {
  refs: number;
  release?: (() => Promise<void>) | undefined;
  starting?: Promise<void> | undefined;
};

/**
 * The daemon's folder watches: one ace-files watch per checkout, shared by every client and
 * thread on it, and each client's own folder sets for each thread. A batch names the folders it
 * makes stale (the fan-out's job); this book owns the subscriptions and the pushers, so a closed
 * socket or an idle checkout stops watching with nothing leaked. One client's calls run in order,
 * and a socket that closed while a watch was starting releases that watch behind its own close.
 */
export class FolderWatch {
  readonly #ports: FolderWatchPorts;
  readonly #fanout: WatchFanout;
  readonly #clients = new Map<string, FolderWatchClient>();
  readonly #roots = new Map<string, RootSubscription>();
  readonly #watched = new Map<string, Map<ThreadId, string>>();
  readonly #tails = new Map<string, Promise<void>>();
  /** Sockets that closed: nothing new may start for them, queued or otherwise. */
  readonly #gone = new Set<string>();
  #closed = false;

  constructor(ports: FolderWatchPorts, options: FolderWatchOptions) {
    this.#ports = ports;
    this.#fanout = new WatchFanout({
      clock: options.clock,
      send: (clientId, update) => this.#push(clientId, update),
      ...(options.windowMs === undefined ? {} : { windowMs: options.windowMs }),
    });
  }

  /**
   * Replace one client's watched folders of a thread; `[]` stops watching it. Calls for one
   * client run in order, so two lists of folders cannot race their root subscription.
   */
  watch(
    client: FolderWatchClient,
    threadId: ThreadId,
    root: string,
    folders: readonly string[],
  ): Promise<void> {
    if (this.#gone.has(client.id)) return Promise.resolve();
    this.#clients.set(client.id, client);
    return this.#enqueue(client.id, () => this.#apply(client.id, threadId, root, folders));
  }

  /** Stop watching one thread of one client. */
  stop(clientId: string, threadId: ThreadId): Promise<void> {
    if (this.#gone.has(clientId)) return Promise.resolve();
    return this.#enqueue(clientId, () => this.#stop(clientId, threadId));
  }

  /** The socket closed: after its queued work, drop its sets, pushes and subscriptions. */
  disconnect(clientId: string): Promise<void> {
    if (this.#gone.has(clientId)) return Promise.resolve();
    this.#gone.add(clientId);
    return this.#enqueue(clientId, () => this.#drop(clientId));
  }

  /** Stop every watch; the daemon is going away. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const clientId of this.#clients.keys()) await this.disconnect(clientId);
    for (const root of this.#roots.keys()) {
      const entry = this.#roots.get(root);
      this.#roots.delete(root);
      if (entry?.release) await entry.release().catch(() => {});
    }
  }

  async #apply(
    clientId: string,
    threadId: ThreadId,
    root: string,
    folders: readonly string[],
  ): Promise<void> {
    if (this.#closed || this.#gone.has(clientId)) return;
    if (!folders.length) {
      await this.#stop(clientId, threadId);
      return;
    }
    let threads = this.#watched.get(clientId);
    if (!threads) {
      threads = new Map();
      this.#watched.set(clientId, threads);
    }
    const evicted = this.#fanout.watch(clientId, threadId, root, folders);
    const current = threads.get(threadId);
    if (current !== root) {
      threads.set(threadId, root);
      try {
        await this.#acquire(root);
      } catch (error) {
        threads.delete(threadId);
        this.#fanout.stop(clientId, threadId);
        if (evicted) await this.#forget(clientId, evicted.threadId, evicted.root);
        throw error;
      }
      if (current !== undefined) await this.#release(current);
    }
    if (evicted) await this.#forget(clientId, evicted.threadId, evicted.root);
  }

  async #stop(clientId: string, threadId: ThreadId): Promise<void> {
    this.#fanout.stop(clientId, threadId);
    const threads = this.#watched.get(clientId);
    const root = threads?.get(threadId);
    if (!threads || root === undefined) return;
    threads.delete(threadId);
    if (!threads.size) this.#watched.delete(clientId);
    await this.#release(root);
  }

  async #drop(clientId: string): Promise<void> {
    this.#clients.delete(clientId);
    this.#fanout.disconnect(clientId);
    this.#tails.delete(clientId);
    const threads = this.#watched.get(clientId);
    this.#watched.delete(clientId);
    if (!threads) return;
    for (const root of threads.values()) await this.#release(root);
  }

  /** Drop an evicted thread's root too, unless another of its threads still uses it. */
  async #forget(clientId: string, threadId: ThreadId, root: string): Promise<void> {
    const threads = this.#watched.get(clientId);
    if (threads?.get(threadId) !== root) return;
    threads.delete(threadId);
    if (!threads.size) this.#watched.delete(clientId);
    await this.#release(root);
  }

  /** One push, checked against the thread's checkout and the socket's live access. */
  #push(clientId: string, update: FoldersUpdate): void {
    const client = this.#clients.get(clientId);
    if (!client) return;
    const root = this.#watched.get(clientId)?.get(update.threadId);
    if (root === undefined) return;
    if (!client.sendable()) {
      void this.#stopNow(clientId, update.threadId);
      return;
    }
    if (!client.valid({ id: update.threadId, root })) {
      const folders = this.#fanout.folders(clientId, update.threadId);
      void this.#stopNow(clientId, update.threadId);
      this.#send(client, {
        type: "files.folders_changed",
        threadId: update.threadId,
        folders,
        rescan: true,
      });
      return;
    }
    this.#send(client, {
      type: "files.folders_changed",
      threadId: update.threadId,
      folders: update.folders,
      rescan: update.rescan,
    });
  }

  #send(client: FolderWatchClient, message: FoldersChanged): void {
    try {
      client.send(message);
    } catch {
      // A socket that cannot take the push is its own session's to close.
    }
  }

  /** Stop a thread's watch from inside a push; the caller owns no ordering there. */
  async #stopNow(clientId: string, threadId: ThreadId): Promise<void> {
    this.#fanout.stop(clientId, threadId);
    const threads = this.#watched.get(clientId);
    const root = threads?.get(threadId);
    if (!threads || root === undefined) return;
    threads.delete(threadId);
    if (!threads.size) this.#watched.delete(clientId);
    await this.#release(root);
  }

  /** One shared upstream watch per checkout, kept while any client watches it. */
  #acquire(root: string): Promise<void> {
    let entry = this.#roots.get(root);
    if (!entry) {
      entry = { refs: 0 };
      this.#roots.set(root, entry);
    }
    entry.refs++;
    if (entry.release || entry.starting) return entry.starting ?? Promise.resolve();
    entry.starting = this.#ports
      .watch(root, (payload) => this.#fanout.batch(root, payload))
      .then(
        (release) => {
          entry.starting = undefined;
          if (entry.refs > 0) {
            entry.release = release;
            return;
          }
          // Every client stopped watching while the subscription was starting.
          if (this.#roots.get(root) === entry) this.#roots.delete(root);
          void release().catch(() => {});
        },
        (error: unknown) => {
          entry.starting = undefined;
          if (this.#roots.get(root) === entry) this.#roots.delete(root);
          entry.refs = 0;
          throw error;
        },
      );
    return entry.starting;
  }

  async #release(root: string): Promise<void> {
    const entry = this.#roots.get(root);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0 || entry.starting) return;
    this.#roots.delete(root);
    const release = entry.release;
    entry.release = undefined;
    if (release) await release().catch(() => {});
  }

  #enqueue(clientId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.#tails.get(clientId) ?? Promise.resolve();
    const next = previous.then(task);
    this.#tails.set(
      clientId,
      next.catch(() => {}),
    );
    return next;
  }
}

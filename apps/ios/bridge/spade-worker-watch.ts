import type { ClientCore } from "@ace/client";
import type { ThreadListEntry } from "@ace/protocol";
import { delegatedState } from "@ace/ui-core";
import { listedSubagentState } from "@ace/ui-core/subagent-group";
import type { SpadeAgent } from "@ace/ui-core/spade-chat";
import type { SpadeBubbleRow } from "./spade-rows.ts";
import type { SpadeWorkerFacts } from "./spade-worker-rows.ts";

/*
 * The open Spade chat's ace workers as ace's thread list has them, live: while a conversation is
 * open this holds the SDK's list (shared with the inbox) and calls `changed` when a worker's
 * thread changes, or the list as a whole does, so the chat's rows follow without reopening it.
 * A worker the daemon's list doesn't hold (an older chat's, past the loaded window, or archived)
 * is read from its own thread instead, through a lease that yields to the views that need room,
 * so it never reads as running forever. A worker waiting on the person names the threads of its
 * tree that do: those the list holds, and those the daemon's `askingThreads` hints lead to, each
 * read from its own thread when the list lacks it (archived, or past the loaded window), so its
 * request is found even below a thread the list doesn't hold.
 */

const listWide = new Set(["ids", "unconfirmed", "sync", "error"]);
const threadWide = new Set(["thread", "unconfirmed", "sync", "error"]);

type Owner = Pick<ClientCore, "threads" | "thread" | "threadRoom">;
type Lease = ReturnType<ClientCore["thread"]>;
type Listed = ReturnType<SpadeWorkerFacts["listed"]>;
type Live = ThreadListEntry["live"];

/** At most this many threads below a worker are followed, whatever the hints say. */
const followsMost = 16;

export class SpadeWorkerWatch {
  private lease: ReturnType<ClientCore["threads"]> | undefined;
  private stopObserving: (() => void) | undefined;
  /** Listens for room to free up, while a read was refused for lack of it. */
  private stopRoom: (() => void) | undefined;
  /** The ace workers the open chat shows, and the delegated threads they wait on, by thread. */
  private shown: ReadonlySet<string> = new Set();
  /** Workers the list doesn't hold, each read from its own thread. */
  private readonly direct = new Map<string, { lease: Lease; stop: () => void }>();
  private stopped = false;
  /** The threads below each worker last read from their own thread, kept while it shows. */
  private readonly below = new Map<string, ReadonlySet<string>>();
  /** What each worker's hints last named below it, kept while the list isn't settled. */
  private readonly hints = new Map<string, readonly string[]>();
  private readonly owner: Owner;
  private readonly changed: () => void;

  constructor(owner: Owner, changed: () => void) {
    this.owner = owner;
    this.changed = changed;
  }

  /** What is known of the workers now, with bots from `agents`. */
  facts(
    agents: () => readonly SpadeAgent[] | undefined,
    node: SpadeWorkerFacts["node"],
  ): SpadeWorkerFacts {
    // Built once per read, and only when a worker waits on the person.
    let children: Map<string, string[]> | undefined;
    return {
      // The list is held only once a chat shows an ace worker.
      listed: (thread) => {
        const store = this.store();
        if (!store) return undefined;
        const entry = store.thread(thread);
        if (entry) {
          this.forget(thread);
          const state = listedSubagentState(store, thread);
          return state && { state, asking: entry.live?.asking?.[0]?.kind };
        }
        // Only the daemon's own list says a thread is missing from it.
        if (!store.loaded || store.unconfirmed || store.syncing || store.error) return undefined;
        return this.read(thread);
      },
      waiting: (thread) => {
        const store = this.store();
        if (!store) return [thread];
        children ??= childrenOf(store);
        const found = new Set(waitingBelow(thread, store, children));
        for (const id of this.hinted(thread, store)) found.add(id);
        found.delete(thread);
        return [thread, ...found];
      },
      bot: (id) => agents()?.find((agent) => agent.id === id),
      node,
    };
  }

  /** The open chat's rows as last put: only their ace workers' threads redraw it. */
  showing(rows: readonly { row: SpadeBubbleRow }[]): void {
    const workers = new Set<string>();
    const shown = new Set<string>();
    for (const { row } of rows) {
      if (row.kind !== "workers") continue;
      for (const worker of row.workers) {
        if (worker.thread) workers.add(worker.thread);
        for (const thread of [worker.thread ?? [], worker.asking].flat()) shown.add(thread);
      }
    }
    this.shown = shown;
    const kept = new Set(workers);
    for (const worker of this.below.keys())
      if (workers.has(worker)) for (const thread of this.below.get(worker) ?? []) kept.add(thread);
      else {
        this.below.delete(worker);
        this.hints.delete(worker);
      }
    for (const thread of this.direct.keys()) if (!kept.has(thread)) this.forget(thread);
  }

  stop(): void {
    this.stopped = true;
    this.stopObserving?.();
    this.stopObserving = undefined;
    this.lease?.release();
    this.lease = undefined;
    this.stopRoom?.();
    this.stopRoom = undefined;
    for (const thread of this.direct.keys()) this.forget(thread);
    this.below.clear();
    this.hints.clear();
    this.shown = new Set();
  }

  /**
   * Read the refused workers again once room frees up. The SDK is still walking its listeners when
   * this one runs, and a retry that takes the room (or registers again at once) would be called by
   * that same walk, so the retry waits for a microtask and checks there is room first.
   */
  private waitForRoom() {
    if (this.stopRoom) return;
    const room = this.owner.threadRoom();
    let live = true;
    const off = room.subscribe(() => {
      if (!live) return;
      live = false;
      off();
      this.stopRoom = undefined;
      queueMicrotask(() => {
        if (this.stopped) return;
        if (room.getSnapshot() <= 0) return this.waitForRoom();
        this.changed();
      });
    });
    this.stopRoom = () => {
      live = false;
      off();
    };
  }

  /**
   * The threads below `worker` that the daemon's `askingThreads` hints say wait on the person,
   * nearest first, each one the list lacks read from its own thread. While the list isn't
   * settled it can't say which threads it lacks, so the last walk's threads stand, and stay read.
   */
  private hinted(worker: string, list: Listing & Settled): readonly string[] {
    if (!list.loaded || list.unconfirmed || list.syncing || list.error)
      return this.hints.get(worker) ?? [];
    const found: string[] = [];
    const read = new Set<string>();
    const seen = new Set([worker]);
    const queue = [worker];
    for (const id of queue) {
      if (found.length >= followsMost) break;
      for (const child of this.live(id, list, read)?.askingThreads ?? []) {
        if (found.length >= followsMost) break;
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        found.push(child.id);
        queue.push(child.id);
      }
    }
    this.below.set(worker, read);
    this.hints.set(worker, found);
    return found;
  }

  /** A thread's live hints: the list's, else its own thread's once that says. */
  private live(thread: string, list: Listing & Settled, read: Set<string>): Live {
    const entry = list.thread(thread);
    if (entry) return entry.live;
    // Only the daemon's own list says a thread is missing from it.
    if (!list.loaded || list.unconfirmed || list.syncing || list.error) return undefined;
    read.add(thread);
    return this.settled(thread)?.live;
  }

  /** A worker the list doesn't hold, from its own thread; undefined until that says. */
  private read(thread: string): Listed {
    const read = this.settled(thread);
    const status = read?.status;
    if (!status || status.state === "new") return undefined;
    return { state: delegatedState(status), asking: read?.live?.asking?.[0]?.kind };
  }

  /** A thread the list doesn't hold, from its own thread; undefined until that says. */
  private settled(thread: string) {
    let held = this.direct.get(thread);
    if (!held) {
      let lease: Lease;
      try {
        lease = this.owner.thread(thread, { optional: true });
      } catch {
        return undefined;
      }
      // Refused for lack of room: nothing is held, so nothing is kept to read the refusal again.
      // The read is tried again when room frees up.
      if (lease.store.error?.code === "no_room") {
        lease.release();
        this.waitForRoom();
        return undefined;
      }
      const stop = lease.store.observe((keys) => {
        if (keys === "all" || [...keys].some((key) => threadWide.has(key))) this.changed();
      });
      held = { lease, stop };
      this.direct.set(thread, held);
    }
    const { store } = held.lease;
    if (store.error?.code === "no_room") {
      // Gave its room to a thread the person opened: let go, and read again when there is room.
      this.forget(thread);
      this.waitForRoom();
      return undefined;
    }
    if (store.error || store.syncing || store.unconfirmed) return undefined;
    return store.thread;
  }

  private forget(thread: string) {
    const held = this.direct.get(thread);
    if (!held) return;
    this.direct.delete(thread);
    held.stop();
    held.lease.release();
  }

  private store() {
    if (this.lease) return this.lease.store;
    try {
      this.stopped = false;
      this.lease = this.owner.threads();
    } catch {
      // Offline: the workers read as still at work until the list is back.
      return undefined;
    }
    this.stopObserving = this.lease.store.observe((keys) => {
      if (this.shown.size === 0) return;
      if (keys === "all") return this.changed();
      for (const key of keys)
        if (listWide.has(key) || (key.startsWith("thread:") && this.shown.has(key.slice(7))))
          return this.changed();
    });
    return this.lease.store;
  }
}

type Listing = { ids: readonly string[]; thread(id: string): ThreadListEntry | undefined };
type Settled = { loaded: boolean; unconfirmed: boolean; syncing: boolean; error: unknown };

/** Each listed thread's delegated children, by the thread that delegated them. */
function childrenOf(list: Listing): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const id of list.ids) {
    const parent = list.thread(id)?.delegatedBy;
    if (parent) children.set(parent, [...(children.get(parent) ?? []), id]);
  }
  return children;
}

/** The listed threads below `thread` that wait on the person, nearest first. */
function waitingBelow(thread: string, list: Listing, children: Map<string, string[]>): string[] {
  const found: string[] = [];
  const seen = new Set([thread]);
  const queue = [...(children.get(thread) ?? [])];
  // An array's iterator reaches what is pushed while it runs: breadth first.
  for (const id of queue) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (list.thread(id)?.status.state === "needs_you") found.push(id);
    queue.push(...(children.get(id) ?? []));
  }
  return found;
}

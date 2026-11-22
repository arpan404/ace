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
 * so it never reads as running forever.
 */

const listWide = new Set(["ids", "unconfirmed", "sync", "error"]);
const threadWide = new Set(["thread", "unconfirmed", "sync", "error"]);

type Owner = Pick<ClientCore, "threads" | "thread" | "threadRoom">;
type Lease = ReturnType<ClientCore["thread"]>;
type Listed = ReturnType<SpadeWorkerFacts["listed"]>;

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
        return [thread, ...waitingBelow(thread, store, children)];
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
    for (const thread of this.direct.keys()) if (!workers.has(thread)) this.forget(thread);
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

  /** A worker the list doesn't hold, from its own thread; undefined until that says. */
  private read(thread: string): Listed {
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
    const status = store.thread?.status;
    if (!status || status.state === "new") return undefined;
    return { state: delegatedState(status), asking: store.thread?.live?.asking?.[0]?.kind };
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

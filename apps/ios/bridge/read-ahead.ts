import type { SidebarReader, ThreadReader } from "@ace/client";
import { sidebarSettled, sidebarVisible } from "@ace/projection";
import type { ThreadListEntry } from "@ace/protocol";

/*
 * Reading ahead (ADR 0128, decision 4): once the inbox is the machine's, the threads the person
 * is most likely to open are read one at a time through optional leases, each let go once its
 * machine confirmed it, so opening one paints from memory and resumes from its cursor. Optional
 * leases take only spare subscription slots and give way to any thread the person opens. Only
 * while native says the network and power allow it (`allowed`): unmetered, unconstrained, not
 * Low Power Mode.
 */

/** Threads read ahead per pass. */
export const readAheadLimit = 4;
/** A thread not confirmed within this long is let go, and the pass moves on. */
const confirmMs = 15_000;
/** Inbox changes come in bursts at launch: a pass starts once they settle. */
const settleMs = 1_500;
/** Only threads changed this recently: older ones would be gone from the cache anyway (ADR 0105). */
const recentMs = 7 * 24 * 60 * 60 * 1000;

/**
 * Which threads to read ahead, most likely first: unsettled ones (working, needing the person,
 * done but unread), then settled, each by most recent change. `skip` names ones that need no read.
 */
export function readAheadPicks(
  list: SidebarReader,
  skip: (id: string, entry: ThreadListEntry) => boolean,
  now: number,
  limit = readAheadLimit,
): string[] {
  if (!list.loaded || list.syncing || list.unconfirmed) return [];
  const entries: ThreadListEntry[] = [];
  for (const id of list.ids) {
    const entry = list.thread(id);
    if (!entry || !sidebarVisible(entry) || now - entry.updatedAt > recentMs) continue;
    if (skip(id, entry)) continue;
    entries.push(entry);
  }
  entries.sort((a, b) => {
    const settled = Number(sidebarSettled(a)) - Number(sidebarSettled(b));
    return settled || b.updatedAt - a.updatedAt;
  });
  return entries.slice(0, limit).map((entry) => entry.id);
}

export interface ReadAheadPorts {
  /** The machine's thread list, when the client has one. */
  list(): SidebarReader | undefined;
  /** Follow the list's changes. */
  observeList(listener: () => void): () => void;
  /** Hold a thread through an optional lease. */
  lease(id: string): { store: ReadAheadStore; release(): void };
  /** Whether the client already keeps `id` in memory: reopening it needs no read. */
  held(id: string): boolean;
  /** The thread open on the phone, if any. */
  open(): string | undefined;
  schedule(delayMs: number, run: () => void): () => void;
  now(): number;
}
export type ReadAheadStore = Pick<ThreadReader, "syncing" | "unconfirmed" | "cursor" | "error"> & {
  observe(tap: () => void): () => void;
};

export class ReadAhead {
  readonly #ports: ReadAheadPorts;
  #allowed = false;
  #stopList: (() => void) | undefined;
  #cancelPass: (() => void) | undefined;
  /** The read in progress: let it go. */
  #current: (() => void) | undefined;
  /** Threads read this session, with the change they were read at. */
  readonly #read = new Map<string, number>();
  #running = false;

  constructor(ports: ReadAheadPorts) {
    this.#ports = ports;
  }

  start(): void {
    this.#stopList ??= this.#ports.observeList(() => this.#soon());
    this.#soon();
  }

  /** Native's verdict on the network and power: a pass runs only while it allows one. */
  allow(allowed: boolean): void {
    this.#allowed = allowed;
    if (allowed) this.#soon();
    else this.#halt();
  }

  stop(): void {
    this.#stopList?.();
    this.#stopList = undefined;
    this.#halt();
  }

  #halt(): void {
    this.#cancelPass?.();
    this.#cancelPass = undefined;
    this.#current?.();
    this.#current = undefined;
  }

  #soon(): void {
    if (!this.#allowed || this.#running) return;
    this.#cancelPass?.();
    this.#cancelPass = this.#ports.schedule(settleMs, () => {
      this.#cancelPass = undefined;
      void this.#pass();
    });
  }

  async #pass(): Promise<void> {
    const list = this.#ports.list();
    if (!list || !this.#allowed) return;
    const picks = readAheadPicks(
      list,
      (id, entry) =>
        id === this.#ports.open() || this.#ports.held(id) || this.#read.get(id) === entry.updatedAt,
      this.#ports.now(),
    );
    this.#running = true;
    try {
      for (const id of picks) {
        if (!this.#allowed) return;
        const entry = this.#ports.list()?.thread(id);
        if (!entry || this.#ports.held(id) || id === this.#ports.open()) continue;
        const outcome = await this.#readOne(id);
        // No spare slot: the person's own threads come first; try again at the next change.
        if (outcome === "no_room") return;
        if (outcome === "confirmed") this.#read.set(id, entry.updatedAt);
      }
    } finally {
      this.#running = false;
    }
  }

  #readOne(id: string): Promise<"confirmed" | "no_room" | "gave_up"> {
    const { store, release } = this.#ports.lease(id);
    return new Promise((resolve) => {
      let done = false;
      let stopObserving: (() => void) | undefined;
      let cancelTimer: (() => void) | undefined;
      const finish = (outcome: "confirmed" | "no_room" | "gave_up") => {
        if (done) return;
        done = true;
        stopObserving?.();
        cancelTimer?.();
        this.#current = undefined;
        release();
        resolve(outcome);
      };
      const check = () => {
        if (store.error) finish(store.error.code === "no_room" ? "no_room" : "gave_up");
        else if (store.cursor !== undefined && !store.syncing && !store.unconfirmed)
          finish("confirmed");
      };
      this.#current = () => finish("gave_up");
      stopObserving = store.observe(check);
      cancelTimer = this.#ports.schedule(confirmMs, () => finish("gave_up"));
      check();
    });
  }
}

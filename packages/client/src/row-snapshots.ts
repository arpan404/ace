import { sidebarSettled } from "@ace/projection";
import type { ThreadListEntry } from "@ace/protocol";
import { itemFinished } from "./item-finished.ts";
import type { ReadSnapshotStorage } from "./read-snapshot-storage.ts";
import {
  expiredSnapshots,
  snapshotRetention,
  type KeptSnapshot,
  type RetentionPolicy,
} from "./snapshot-retention.ts";

/*
 * Read snapshots kept as rows (ADR 0105). A thread's record is stored as one head (the thread,
 * its agents, runs, item order and sequences) plus one row per item, keyed by the record's key
 * and the item id, so each item is held once. A finished item never changes: it is written the
 * first time it is seen finished and never again. Each write sends the head, the items still
 * streaming or changed, and the ids that left the window, so a long finished transcript costs
 * nothing per write. Other records (the inbox list) are kept whole.
 *
 * The platform stores the rows (`SnapshotRows`); this decides what to write and, through
 * `snapshot-retention.ts`, what to let go.
 */

/** One item of a thread as stored: its id and its JSON (no raw newline, as JSON never has). */
export interface ItemRow {
  id: string;
  text: string;
}

export interface ThreadWrite {
  key: string;
  /** The inbox shows this thread as settled. */
  settled: boolean;
  head: string;
  /** Items to insert or replace. */
  items: ItemRow[];
  /** Item ids to delete. */
  removed: string[];
  /** Delete every stored item of the thread before inserting `items`. */
  replace: boolean;
}

/**
 * What a platform stores for one daemon and device. No policy: it keeps what it is told and
 * stamps each entry with its clock when it is read or written. A thread write is all or nothing.
 */
export interface SnapshotRows {
  /** A record's text, or "" for a miss. */
  record(key: string): Promise<string>;
  setRecord(key: string, text: string): Promise<void>;
  /** A thread's head and items, already parsed, or undefined for a miss. */
  thread(key: string): Promise<{ head: unknown; items: unknown[] } | undefined>;
  putThread(write: ThreadWrite): Promise<void>;
  /** Everything kept, with its last use and size. */
  index(): Promise<KeptSnapshot[]>;
  drop(keys: readonly string[]): Promise<void>;
  clear(): Promise<void>;
  /** How many bytes the store takes on disk. */
  size(): Promise<number>;
}

export interface RowSnapshotOptions {
  now(): number;
  policy?: RetentionPolicy;
}

/** A thread's record key as the SDK files it (`thread:<id>`, under the daemon's identity). */
const threadKey = /(?:^|\/)thread:[^/]+$/;

/** What storage holds of one thread, as far as this session knows. */
interface Held {
  items: Set<string>;
  finished: Set<string>;
}

export class RowSnapshots implements ReadSnapshotStorage {
  #rows: SnapshotRows;
  #now: () => number;
  #policy: RetentionPolicy;
  #held = new Map<string, Held>();
  /** Moves on every clear: whatever was read or listed before it describes nothing now. */
  #epoch = 0;
  /**
   * Moves per key on every write, drop and delete, so a read or listing taken before one never
   * describes storage. Never reset: it orders changes, it does not say what is kept.
   */
  #versions = new Map<string, number>();
  /** Thread keys this session knows are kept, each with whether it was last kept settled. */
  #kept = new Map<string, boolean>();
  /** Bytes written since the last sweep. */
  #grown = 0;
  #swept = false;
  #sweeping: Promise<void> | undefined;
  #again = false;

  constructor(rows: SnapshotRows, options: RowSnapshotOptions) {
    this.#rows = rows;
    this.#now = options.now;
    this.#policy = options.policy ?? snapshotRetention;
  }

  async get(key: string): Promise<unknown> {
    this.#sweepOnce();
    try {
      const epoch = this.#epoch;
      const version = this.#version(key);
      if (!threadKey.test(key)) {
        const text = await this.#rows.record(key);
        if (this.#stale(key, epoch, version)) return undefined;
        return text === "" ? undefined : JSON.parse(text);
      }
      const stored = await this.#rows.thread(key);
      // Cleared, dropped or rewritten while it was read: it neither shows nor counts as kept.
      if (!stored || this.#stale(key, epoch, version)) return undefined;
      const value = joinThread(stored.head, stored.items);
      if (!value) return undefined;
      if (!this.#held.has(key)) {
        const ids = Object.keys(value.items);
        this.#held.set(key, {
          items: new Set(ids),
          finished: new Set(ids.filter((id) => itemFinished(value.items[id]))),
        });
      }
      if (!this.#kept.has(key)) this.#kept.set(key, settled(objectOf(value.record.view)?.thread));
      return value.record;
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown): Promise<void> {
    this.#sweepOnce();
    if (!threadKey.test(key)) {
      let text: string | undefined;
      try {
        text = JSON.stringify(value);
      } catch {
        return Promise.resolve();
      }
      if (text === undefined) return Promise.resolve();
      return this.#rows.setRecord(key, text).catch(() => {});
    }
    let write: ThreadWrite | undefined;
    try {
      write = this.#threadWrite(key, value);
    } catch {
      write = undefined;
    }
    if (!write) return Promise.resolve();
    this.#bump(key);
    // Pruning is due when a thread is first kept (again), when it settles or unsettles, and after
    // every sixteenth of the byte cap written.
    const was = this.#kept.get(key);
    this.#kept.set(key, write.settled);
    this.#grown += write.head.length + write.items.reduce((sum, item) => sum + item.text.length, 0);
    const due =
      was === undefined || was !== write.settled || this.#grown >= this.#policy.maxBytes / 16;
    return this.#rows.putThread(write).then(
      () => {
        if (due) void this.#sweep();
      },
      () => {
        // Storage may hold any earlier state: the next write replaces it whole.
        this.#held.delete(key);
      },
    );
  }

  async clear(): Promise<void> {
    this.#epoch++;
    this.#held.clear();
    this.#kept.clear();
    this.#grown = 0;
    await this.#rows.clear();
  }

  /** Drop one record or thread; the drop is asked before this returns, ahead of any later read. */
  delete(key: string): Promise<void> {
    this.#forget(key);
    return this.#rows.drop([key]);
  }

  #version(key: string): number {
    return this.#versions.get(key) ?? 0;
  }
  #bump(key: string): void {
    this.#versions.set(key, this.#version(key) + 1);
  }
  #stale(key: string, epoch: number, version: number): boolean {
    return this.#epoch !== epoch || this.#version(key) !== version;
  }
  /** Storage no longer holds `key`, or is about to not. */
  #forget(key: string): void {
    this.#bump(key);
    this.#held.delete(key);
    this.#kept.delete(key);
  }

  /** What is kept: how many threads, and how many bytes the store takes on disk. */
  async usage(): Promise<{ threads: number; bytes: number }> {
    const [kept, bytes] = await Promise.all([this.#rows.index(), this.#rows.size()]);
    return { threads: kept.filter((entry) => entry.kind === "thread").length, bytes };
  }

  /** Let go of what the policy no longer keeps. */
  expire(): Promise<void> {
    this.#swept = true;
    return this.#sweep();
  }

  #sweepOnce(): void {
    if (this.#swept) return;
    this.#swept = true;
    void this.#sweep();
  }

  #sweep(): Promise<void> {
    if (this.#sweeping) {
      this.#again = true;
      return this.#sweeping;
    }
    this.#sweeping = this.#expireNow()
      .catch(() => {})
      .finally(() => {
        this.#sweeping = undefined;
        if (this.#again) {
          this.#again = false;
          void this.#sweep();
        }
      });
    return this.#sweeping;
  }

  async #expireNow(): Promise<void> {
    this.#grown = 0;
    const epoch = this.#epoch;
    const versions = new Map(this.#versions);
    const listed = await this.#rows.index();
    if (this.#epoch !== epoch) return;
    // A key written, dropped or deleted while it was listed is judged at the next sweep.
    const kept = listed.filter(
      (entry) => this.#version(entry.key) === (versions.get(entry.key) ?? 0),
    );
    // Whole-thread records from builds before rows: never read again.
    const legacy = kept.filter((entry) => entry.kind === "record" && threadKey.test(entry.key));
    const current = kept.filter((entry) => !legacy.includes(entry));
    const drop = [
      ...legacy.map((entry) => entry.key),
      ...expiredSnapshots(current, this.#now(), this.#policy),
    ];
    const dropping = new Set(drop);
    for (const entry of kept)
      if (entry.kind === "thread" && !dropping.has(entry.key))
        this.#kept.set(entry.key, entry.settled);
    if (!drop.length) return;
    for (const key of drop) this.#forget(key);
    await this.#rows.drop(drop);
  }

  /** What to send for a thread record: its head and only the items storage lacks. */
  #threadWrite(key: string, value: unknown): ThreadWrite | undefined {
    const record = objectOf(value);
    const view = objectOf(record?.view);
    const items = objectOf(view?.items);
    if (!record || !view || !items) return undefined;
    const { items: _items, ...rest } = view;
    const head = JSON.stringify({ ...record, view: rest });
    const held = this.#held.get(key);
    const ids = new Set<string>();
    const finished = new Set<string>();
    const rows: ItemRow[] = [];
    for (const id of Object.keys(items)) {
      ids.add(id);
      if (held?.finished.has(id)) {
        finished.add(id);
        continue;
      }
      const item = items[id];
      const text = JSON.stringify(item);
      if (text === undefined) continue;
      rows.push({ id, text });
      if (itemFinished(item)) finished.add(id);
    }
    const removed = held ? [...held.items].filter((id) => !ids.has(id)) : [];
    this.#held.set(key, { items: ids, finished });
    return { key, settled: settled(view.thread), head, items: rows, removed, replace: !held };
  }
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Whether the inbox shows `thread` as settled; anything unreadable is not. */
function settled(thread: unknown): boolean {
  const entry = objectOf(thread);
  if (!entry || !objectOf(entry.status)) return false;
  try {
    return sidebarSettled(entry as unknown as ThreadListEntry);
  } catch {
    return false;
  }
}

/** A record put back together from its head and item rows; a row without an id is left out. */
function joinThread(
  rawHead: unknown,
  rows: readonly unknown[],
): { record: Record<string, unknown>; items: Record<string, unknown> } | undefined {
  const head = objectOf(rawHead);
  const view = objectOf(head?.view);
  if (!head || !view) return undefined;
  const items: Record<string, unknown> = {};
  for (const row of rows) {
    const item = objectOf(row);
    if (typeof item?.id !== "string") continue;
    Object.defineProperty(items, item.id, {
      value: item,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return { record: { ...head, view: { ...view, items } }, items };
}

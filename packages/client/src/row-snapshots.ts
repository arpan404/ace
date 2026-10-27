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
  /** Writes started per thread key, so a read that raced a write never describes storage. */
  #writes = new Map<string, number>();
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
      if (!threadKey.test(key)) {
        const text = await this.#rows.record(key);
        return text === "" ? undefined : JSON.parse(text);
      }
      const writes = this.#writes.get(key) ?? 0;
      const stored = await this.#rows.thread(key);
      if (!stored) return undefined;
      const value = joinThread(stored.head, stored.items);
      if (!value) return undefined;
      if ((this.#writes.get(key) ?? 0) === writes && !this.#held.has(key)) {
        const ids = Object.keys(value.items);
        this.#held.set(key, {
          items: new Set(ids),
          finished: new Set(ids.filter((id) => itemFinished(value.items[id]))),
        });
      }
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
    const first = !this.#writes.has(key);
    this.#writes.set(key, (this.#writes.get(key) ?? 0) + 1);
    return this.#rows.putThread(write).then(
      () => {
        if (first) this.#sweep();
      },
      () => {
        // Storage may hold any earlier state: the next write replaces it whole.
        this.#held.delete(key);
      },
    );
  }

  async clear(): Promise<void> {
    this.#held.clear();
    await this.#rows.clear();
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
    const kept = await this.#rows.index();
    // Whole-thread records from builds before rows: never read again.
    const legacy = kept.filter((entry) => entry.kind === "record" && threadKey.test(entry.key));
    const current = kept.filter((entry) => !legacy.includes(entry));
    const drop = [
      ...legacy.map((entry) => entry.key),
      ...expiredSnapshots(current, this.#now(), this.#policy),
    ];
    if (!drop.length) return;
    for (const key of drop) this.#held.delete(key);
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

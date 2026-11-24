import type { Item, ItemsWindowResponse } from "@ace/protocol";
import { startsTurn } from "@ace/projection";
import { itemFinished } from "./item-finished.ts";

/*
 * One thread's archive on the phone (ADR 0149): every item the client has read of it, as disjoint
 * runs. A run holds every item whose creation sequence lies in `[from, through]` (`from` null:
 * since the thread's start), in sequence order, so a window inside a run is answered without the
 * machine. Each run merged in is authoritative for its range. Pure.
 */

interface Entry {
  id: string;
  seq: number;
  item: Item;
  /** JSON length: what the entry costs to hold. */
  weight: number;
  /** The live store clipped it (`limits.text`). */
  clipped: boolean;
  /** Read from the machine or the live store this session. */
  confirmed: boolean;
}

interface Run {
  from: number | null;
  through: number;
  /** In creation-sequence order. */
  entries: Entry[];
}

/** A contiguous read of the thread: every item with a sequence in `[from, through]`. */
export interface ArchiveInput {
  items: readonly Item[];
  seq(id: string): number | undefined;
  from: number | null;
  through: number;
}

export interface ArchiveMergeOptions {
  /** The items were read from the machine or the live store this session. */
  confirmed: boolean;
  /** Ids the live store clipped (`limits.text`): never replace a whole copy with one. */
  clipped?: ReadonlySet<string>;
  /** Items may be shared with their source, which can change them: keep a copy. */
  copy?: boolean;
}

export interface ArchiveQuery {
  aroundSeq?: number | undefined;
  itemId?: string | undefined;
  before: number;
  after: number;
  wholeTurns?: boolean | undefined;
}

export interface ArchiveAnswer {
  reply: ItemsWindowResponse;
  /** Every item came from the machine or the live store this session. */
  confirmed: boolean;
}

/** What an archive holds, as kept on disk (`ThreadArchives`). */
export interface ArchiveRecord {
  runs: { from: number | null; through: number; ids: string[] }[];
  seqs: Record<string, number>;
  clipped: string[];
  items: Record<string, Item>;
}

/** An item whose JSON is larger than this is held in memory but never written to disk. */
export const archiveItemMax = 2 * 1024 * 1024;

const low = (from: number | null) => from ?? Number.NEGATIVE_INFINITY;

export class ThreadArchive {
  readonly threadId: string;
  #runs: Run[] = [];
  #entries = new Map<string, Entry>();
  #bytes = 0;
  /** Moves whenever what the archive holds changes. */
  revision = 0;

  constructor(threadId: string) {
    this.threadId = threadId;
  }

  /** Roughly how much the archive holds: the JSON length of its items. */
  get bytes(): number {
    return this.#bytes;
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * Merge a contiguous read. Inside its range it replaces what the archive held: an item missing
   * from it there was deleted. Runs it meets or overlaps become one. True when anything changed.
   */
  merge(input: ArchiveInput, options: ArchiveMergeOptions): boolean {
    const from = low(input.from);
    const through = input.through;
    if (!(through >= from)) return false;
    const incoming: { id: string; seq: number; item: Item }[] = [];
    let previous = Number.NEGATIVE_INFINITY;
    for (const item of input.items) {
      const seq = input.seq(item.id);
      if (seq === undefined || seq < from || seq > through) continue;
      // Out of order: not the contiguous read it claims to be.
      if (seq <= previous) return false;
      previous = seq;
      incoming.push({ id: item.id, seq, item });
    }
    let first = this.#runs.findIndex((run) => run.through + 1 >= from);
    if (first === -1) first = this.#runs.length;
    let end = first;
    while (end < this.#runs.length && low(this.#runs[end]?.from ?? null) <= through + 1) end++;
    const touched = this.#runs.slice(first, end);
    let changed = touched.length !== 1;
    const keep = new Set(incoming.map((entry) => entry.id));
    const older: Entry[] = [];
    const newer: Entry[] = [];
    for (const run of touched)
      for (const entry of run.entries) {
        if (entry.seq < from) older.push(entry);
        else if (entry.seq > through) newer.push(entry);
        else if (!keep.has(entry.id)) {
          this.#drop(entry);
          changed = true;
        }
      }
    const middle: Entry[] = [];
    for (const { id, seq, item } of incoming) {
      const put = this.#put(id, seq, item, options);
      if (put.changed) changed = true;
      middle.push(put.entry);
    }
    const runFrom = touched.reduce<number | null>(
      (lowest, run) => (lowest === null || run.from === null ? null : Math.min(lowest, run.from)),
      input.from,
    );
    const runThrough = touched.reduce((highest, run) => Math.max(highest, run.through), through);
    const only = touched[0];
    if (only && (only.from !== runFrom || only.through !== runThrough)) changed = true;
    this.#runs.splice(first, end - first, {
      from: runFrom,
      through: runThrough,
      entries: [...older, ...middle, ...newer],
    });
    if (changed) this.revision++;
    return changed;
  }

  /**
   * Refresh items the archive already holds, claiming nothing about their neighbours (the live
   * store's root items kept before its cursor).
   */
  refresh(items: readonly Item[], options: ArchiveMergeOptions): boolean {
    let changed = false;
    for (const item of items) {
      const held = this.#entries.get(item.id);
      if (held && this.#put(item.id, held.seq, item, options).changed) changed = true;
    }
    if (changed) this.revision++;
    return changed;
  }

  /** The window `query` asks for, when a run holds it; undefined sends the read to the machine. */
  window(query: ArchiveQuery): ArchiveAnswer | undefined {
    const located = this.#locate(query);
    if (!located) return undefined;
    const { run, index } = located;
    const entries = run.entries;
    let start = index - Math.min(query.before, index);
    // Nothing older held here, and the thread goes on before the run: only the machine knows.
    if (query.before > 0 && start === index && run.from !== null) return undefined;
    if (query.wholeTurns && start < index && !(start === 0 && run.from === null)) {
      const turn = entries.findIndex(
        (entry, at) => at >= start && at < index && startsTurn(entry.item),
      );
      if (turn !== -1) start = turn;
    }
    const stop = index + Math.min(query.after, entries.length - 1 - index);
    const shown = entries.slice(start, stop + 1);
    const target = entries[index];
    const first = shown[0];
    const last = shown.at(-1);
    if (!target || !first || !last) return undefined;
    const itemSeqs: Record<string, number> = {};
    for (const entry of shown) itemSeqs[entry.id] = entry.seq;
    return {
      confirmed: shown.every((entry) => entry.confirmed),
      reply: {
        type: "items.window",
        requestId: "archive",
        threadId: this.threadId as ItemsWindowResponse["threadId"],
        seq: run.through,
        targetSeq: target.seq,
        items: shown.map((entry) => entry.item),
        itemSeqs,
        itemsBefore: start > 0 ? first.seq : run.from,
        itemsAfter: last.seq,
      },
    };
  }

  /** The items held with sequences in `[fromSeq, throughSeq]`, when one run holds that range. */
  between(
    fromSeq: number,
    throughSeq: number,
  ): { items: Item[]; seqs: Map<string, number> } | undefined {
    const run = this.#runAt(fromSeq);
    if (!run || throughSeq > run.through) return undefined;
    const shown = run.entries.slice(
      this.#lowerBound(run.entries, fromSeq),
      this.#lowerBound(run.entries, throughSeq + 1),
    );
    return {
      items: shown.map((entry) => entry.item),
      seqs: new Map(shown.map((entry) => [entry.id, entry.seq])),
    };
  }

  /** Nothing held is current any more (a new connection): the next answer is checked. */
  unconfirm(): void {
    for (const run of this.#runs) for (const entry of run.entries) entry.confirmed = false;
  }

  /** What to keep on disk: finished items only, since the live record holds the rest. */
  record(): ArchiveRecord {
    const items: Record<string, Item> = {};
    const seqs: Record<string, number> = {};
    const clipped: string[] = [];
    for (const entry of this.#entries.values()) {
      seqs[entry.id] = entry.seq;
      if (entry.clipped) clipped.push(entry.id);
      if (itemFinished(entry.item) && entry.weight <= archiveItemMax)
        Object.defineProperty(items, entry.id, {
          value: entry.item,
          writable: true,
          enumerable: true,
          configurable: true,
        });
    }
    return {
      runs: this.#runs.map((run) => ({
        from: run.from,
        through: run.through,
        ids: run.entries.map((entry) => entry.id),
      })),
      seqs,
      clipped,
      items,
    };
  }

  /**
   * Take a record kept on disk. An item it names but doesn't hold (not yet written, or never
   * finished) splits its run there: what follows is whole only from the next sequence on.
   */
  restore(record: ArchiveRecord): void {
    const clipped = new Set(record.clipped);
    for (const run of record.runs) {
      let from = run.from;
      let items: Item[] = [];
      const flush = (through: number) => {
        if (through >= low(from))
          this.merge(
            { items, seq: (id) => record.seqs[id], from, through },
            { confirmed: false, clipped },
          );
        items = [];
      };
      for (const id of run.ids) {
        const seq = record.seqs[id];
        if (seq === undefined) continue;
        const item = Object.hasOwn(record.items, id) ? record.items[id] : undefined;
        if (item) {
          items.push(item);
          continue;
        }
        flush(seq - 1);
        from = seq + 1;
      }
      flush(run.through);
    }
  }

  #put(
    id: string,
    seq: number,
    item: Item,
    options: ArchiveMergeOptions,
  ): { entry: Entry; changed: boolean } {
    const clipped = options.clipped?.has(id) === true;
    const held = this.#entries.get(id);
    if (held && held.seq === seq) {
      if (options.confirmed && !clipped) held.confirmed = true;
      // A finished item never changes: keep it, unless a whole copy replaces a clipped one. A
      // clipped copy never replaces a whole one.
      if ((itemFinished(held.item) && (!held.clipped || clipped)) || (clipped && !held.clipped))
        return { entry: held, changed: false };
    }
    if (held) this.#drop(held);
    const value = options.copy ? structuredClone(item) : item;
    const entry: Entry = {
      id,
      seq,
      item: value,
      weight: JSON.stringify(value).length,
      clipped,
      confirmed: options.confirmed && !clipped,
    };
    this.#entries.set(id, entry);
    this.#bytes += entry.weight;
    return { entry, changed: true };
  }

  #drop(entry: Entry): void {
    if (this.#entries.get(entry.id) !== entry) return;
    this.#bytes -= entry.weight;
    this.#entries.delete(entry.id);
  }

  #locate(query: ArchiveQuery): { run: Run; index: number } | undefined {
    const seq = query.itemId !== undefined ? this.#entries.get(query.itemId)?.seq : query.aroundSeq;
    if (seq === undefined) return undefined;
    const run = this.#runAt(seq);
    if (!run) return undefined;
    const index = this.#lowerBound(run.entries, seq);
    // The nearest item at or after the target may lie past the run.
    return index < run.entries.length ? { run, index } : undefined;
  }

  #runAt(seq: number): Run | undefined {
    let lo = 0;
    let hi = this.#runs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const run = this.#runs[mid];
      if (!run) return undefined;
      if (seq < low(run.from)) hi = mid - 1;
      else if (seq > run.through) lo = mid + 1;
      else return run;
    }
    return undefined;
  }

  /** The first index in `entries` whose sequence is at least `seq`. */
  #lowerBound(entries: readonly Entry[], seq: number): number {
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((entries[mid]?.seq ?? Number.POSITIVE_INFINITY) < seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

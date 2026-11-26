import type { Item, ItemsWindowResponse } from "@ace/protocol";
import { z } from "zod";
import type { ItemsWindowInput } from "./long-thread.ts";
import type { ReadSnapshotStorage } from "./read-snapshot-storage.ts";
import { ThreadArchive, type ArchiveAnswer, type ArchiveRecord } from "./thread-archive.ts";
import type { ThreadExport } from "./api.ts";
import type { Scheduler } from "./types.ts";

/*
 * The archives a client keeps of the threads it read (ADR 0225): hot in memory, least recently
 * used first, under a byte bound, and on disk as one `archive:<threadId>` record each. An archive
 * is always read from disk before it changes, so a write never drops what disk held.
 */

/** Item JSON kept in memory across threads before written threads are let go. */
export const archiveMemoryBytes = 96 * 1024 * 1024;
/** An archive's changes are written at most once per this many milliseconds. */
export const archiveWriteMs = 2_000;
/** Version 1: runs, sequences, clipped ids and the database they were read under. */
export const archiveRecordVersion = 1;

export interface ArchiveOptions {
  memoryBytes?: number;
}

const Head = z.object({
  version: z.literal(archiveRecordVersion),
  databaseId: z.string().optional(),
  runs: z.array(
    z.object({
      from: z.number().nullable(),
      through: z.number(),
      ids: z.array(z.string()),
    }),
  ),
  seqs: z.record(z.string(), z.number()),
  clipped: z.array(z.string()),
  view: z.object({ thread: z.unknown().optional(), items: z.record(z.string(), z.unknown()) }),
});

interface Held {
  archive: ThreadArchive;
  /** The archive revision disk holds. */
  written: number;
  /** The daemon database its sequences come from, when known. */
  database: string | undefined;
  /** The thread's list entry, so retention knows whether it is settled. */
  thread: unknown;
  cancel: (() => void) | undefined;
  writing: Promise<void> | undefined;
}

const key = (threadId: string) => `archive:${threadId}`;

export class ThreadArchives {
  #storage: ReadSnapshotStorage;
  #scheduler: Scheduler;
  #memory: number;
  /** Least recently used first. */
  #held = new Map<string, Held>();
  #loading = new Map<string, Promise<Held | undefined>>();
  /** Moves on every clear, and per thread on every forget: reads begun before describe nothing. */
  #epoch = 0;
  #generations = new Map<string, number>();
  #database: string | undefined;
  #closed = false;
  #listeners = new Set<(threadId: string) => void>();

  constructor(storage: ReadSnapshotStorage, scheduler: Scheduler, options: ArchiveOptions = {}) {
    this.#storage = storage;
    this.#scheduler = scheduler;
    this.#memory = options.memoryBytes ?? archiveMemoryBytes;
  }

  /** A window answered from the archive, or undefined when the machine has to answer it. */
  async window(input: ItemsWindowInput): Promise<ArchiveAnswer | undefined> {
    if (input.turnOrdinal !== undefined) return undefined;
    const held = await this.#open(input.threadId);
    return held?.archive.window({
      aroundSeq: input.aroundSeq,
      itemId: input.itemId,
      before: input.before ?? 50,
      after: input.after ?? 50,
      wholeTurns: input.wholeTurns,
    });
  }

  /** The items held in memory with sequences in `[fromSeq, throughSeq]`, when one run holds them. */
  between(threadId: string, fromSeq: number, throughSeq: number) {
    return this.#held.get(threadId)?.archive.between(fromSeq, throughSeq);
  }

  /**
   * Take a window the machine answered for a read aimed at `aroundSeq`. Its target is the first
   * item at or after `aroundSeq`, so nothing lies between the two. True when it changed what the
   * archive held.
   */
  async merge(reply: ItemsWindowResponse, aroundSeq?: number): Promise<boolean> {
    const held = await this.#open(reply.threadId);
    if (!held) return false;
    const before = reply.itemsBefore;
    const changed = held.archive.merge(
      {
        items: reply.items,
        seq: (id) => (Object.hasOwn(reply.itemSeqs, id) ? reply.itemSeqs[id] : undefined),
        from: before === null || aroundSeq === undefined ? before : Math.min(before, aroundSeq),
        through: reply.itemsAfter ?? reply.seq,
      },
      { confirmed: true },
    );
    this.#changed(held, reply.threadId);
    return changed;
  }

  /** Take what a confirmed live store holds: whole from its cursor through its sequence. */
  async keep(threadId: string, exported: ThreadExport): Promise<void> {
    const view = exported.view;
    if (!view || exported.syncing || exported.unconfirmed) return;
    const held = await this.#open(threadId);
    if (!held) return;
    const seqs = view.itemSeqs ?? {};
    const seq = (id: string) => (Object.hasOwn(seqs, id) ? seqs[id] : undefined);
    const from = view.itemsBefore;
    const run: Item[] = [];
    const kept: Item[] = [];
    for (const id of view.itemOrder) {
      const item = Object.hasOwn(view.items, id) ? view.items[id] : undefined;
      const at = seq(id);
      if (!item || at === undefined) continue;
      if (from === null || at >= from) run.push(item);
      else kept.push(item);
    }
    const options = { confirmed: true, clipped: new Set(exported.truncated), copy: true };
    held.archive.merge({ items: run, seq, from, through: view.seq }, options);
    held.archive.refresh(kept, options);
    held.thread = view.thread;
    this.#changed(held, threadId);
  }

  /** Called with a thread whose archive the machine corrected. */
  onRevised(listener: (threadId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  revised(threadId: string): void {
    for (const listener of this.#listeners) listener(threadId);
  }

  /**
   * A new connection's welcome. What the daemon changed while the phone was away is unknown, so
   * nothing held is confirmed until read again. Archives read under another database are dropped:
   * its sequences say nothing about this one's (ADR 0128).
   */
  connected(databaseId: string | undefined): void {
    for (const held of this.#held.values()) held.archive.unconfirm();
    if (databaseId === undefined) return;
    this.#database = databaseId;
    for (const [threadId, held] of this.#held)
      if (held.database !== undefined && held.database !== databaseId) void this.forget(threadId);
  }

  /** Drop one thread's archive, in memory and on disk. */
  forget(threadId: string): Promise<void> {
    this.#generations.set(threadId, (this.#generations.get(threadId) ?? 0) + 1);
    this.#loading.delete(threadId);
    const held = this.#held.get(threadId);
    held?.cancel?.();
    this.#held.delete(threadId);
    return this.#storage.delete?.(key(threadId)).catch(() => {}) ?? Promise.resolve();
  }

  /** Every archive goes from memory; the caller clears the storage they share. */
  clear(): void {
    this.#epoch++;
    for (const held of this.#held.values()) held.cancel?.();
    this.#held.clear();
    this.#loading.clear();
  }

  /** Write every archive with changes still unwritten. */
  async close(): Promise<void> {
    const writes = [...this.#held].map(([threadId, held]) => {
      held.cancel?.();
      held.cancel = undefined;
      return this.#write(threadId, held);
    });
    this.#closed = true;
    await Promise.all(writes);
  }

  #fence(threadId: string): () => boolean {
    const epoch = this.#epoch;
    const generation = this.#generations.get(threadId) ?? 0;
    return () => epoch === this.#epoch && generation === (this.#generations.get(threadId) ?? 0);
  }

  #open(threadId: string): Promise<Held | undefined> {
    const held = this.#held.get(threadId);
    if (held) {
      this.#held.delete(threadId);
      this.#held.set(threadId, held);
      return Promise.resolve(held);
    }
    const loading = this.#loading.get(threadId);
    if (loading) return loading;
    const current = this.#fence(threadId);
    const load = this.#read(threadId).then((record) => {
      if (!current()) return undefined;
      if (this.#loading.get(threadId) === load) this.#loading.delete(threadId);
      const archive = new ThreadArchive(threadId);
      if (record) archive.restore(record);
      const opened: Held = {
        archive,
        written: archive.revision,
        database: record?.databaseId,
        thread: record?.thread,
        cancel: undefined,
        writing: undefined,
      };
      this.#held.set(threadId, opened);
      return opened;
    });
    this.#loading.set(threadId, load);
    return load;
  }

  async #read(
    threadId: string,
  ): Promise<(ArchiveRecord & { databaseId?: string; thread: unknown }) | undefined> {
    let value: unknown;
    try {
      value = await this.#storage.get(key(threadId));
    } catch {
      return undefined;
    }
    const head = Head.safeParse(value);
    if (!head.success) return undefined;
    const { databaseId, runs, seqs, clipped, view } = head.data;
    if (this.#database !== undefined && databaseId !== undefined && databaseId !== this.#database) {
      void this.#storage.delete?.(key(threadId)).catch(() => {});
      return undefined;
    }
    // Rows this build wrote from items it had parsed (ADR 0125); only their shape is checked.
    const items: Record<string, Item> = {};
    for (const [id, item] of Object.entries(view.items))
      if (isItem(item) && item.id === id)
        Object.defineProperty(items, id, {
          value: item,
          writable: true,
          enumerable: true,
          configurable: true,
        });
    return {
      runs,
      seqs,
      clipped,
      items,
      thread: view.thread,
      ...(databaseId ? { databaseId } : {}),
    };
  }

  #changed(held: Held, threadId: string): void {
    held.database ??= this.#database;
    if (held.archive.revision !== held.written) this.#schedule(threadId, held);
    this.#trim();
  }

  #schedule(threadId: string, held: Held): void {
    if (this.#closed || held.cancel || held.writing) return;
    held.cancel = this.#scheduler.set(archiveWriteMs, () => {
      held.cancel = undefined;
      void this.#write(threadId, held);
    });
  }

  #write(threadId: string, held: Held): Promise<void> {
    if (held.writing) return held.writing;
    const revision = held.archive.revision;
    if (revision === held.written) return Promise.resolve();
    const current = this.#fence(threadId);
    const { items, ...rest } = held.archive.record();
    const value = {
      version: archiveRecordVersion,
      ...(held.database ? { databaseId: held.database } : {}),
      ...rest,
      view: { ...(held.thread ? { thread: held.thread } : {}), items },
    };
    held.writing = this.#storage
      .set(key(threadId), value)
      .then(
        () => {
          if (current()) held.written = revision;
        },
        () => {},
      )
      .finally(() => {
        held.writing = undefined;
        if (current() && held.archive.revision !== held.written) this.#schedule(threadId, held);
        this.#trim();
      });
    return held.writing;
  }

  /** Past the memory bound, let go of written threads, least recently used first. */
  #trim(): void {
    let total = 0;
    for (const held of this.#held.values()) total += held.archive.bytes;
    if (total <= this.#memory) return;
    const newest = [...this.#held.keys()].at(-1);
    for (const [threadId, held] of this.#held) {
      if (total <= this.#memory) break;
      if (threadId === newest || held.writing || held.archive.revision !== held.written) continue;
      total -= held.archive.bytes;
      this.#held.delete(threadId);
    }
  }
}

function isItem(value: unknown): value is Item {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "type" in value &&
    typeof value.type === "string"
  );
}

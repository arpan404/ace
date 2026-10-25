import type { SQLOutputValue } from "node:sqlite";
import type { Thread } from "@ace/protocol";
import { BoundedCache } from "@ace/provider-kit/bounded-cache";
import { decodeThreadRow } from "./thread-row.ts";

export type FrozenThread = DeepReadonly<Thread>;
type DeepReadonly<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

interface Entry {
  revision: number;
  /** Deeply frozen at runtime; typed mutable only so `copy` can clone it as a Thread. */
  thread: Thread;
  /** Weight of each stored column the thread was read from; `bytes` is their sum. */
  weights: Readonly<Record<string, number>>;
  bytes: number;
}
interface ThreadCacheSource {
  /** The row's current revision on this connection, committed or not. */
  revision(id: string): number | undefined;
  /** The row with its revision as `row_revision`, read by one statement. */
  row(id: string): Record<string, SQLOutputValue> | undefined;
  /** True when this connection is reading committed data only, outside any write. */
  committed(): boolean;
}

/**
 * Decoded threads keyed by the row revision that every insert or update of a threads row
 * bumps (sidebar_thread_revisions triggers, so direct SQL writes count too).
 *
 * Committed reads are stored for good. A committed revision is never handed out again:
 * the AUTOINCREMENT high-water mark commits with it. So a hit is the exact row that
 * revision named, even inside a write transaction that later rolls back, and no rollback
 * elsewhere on the connection has to remember to clear the cache.
 *
 * Reads inside the store's own write transaction are kept apart, for that transaction
 * only: a rollback there could hand the same revision to different content. A savepoint
 * rollback drops them, the commit makes them committed entries, any other end drops them.
 */
export class ThreadCache {
  private readonly entries: BoundedCache<string, Entry>;
  /** Reads of uncommitted rows in the store's open write transaction. */
  private pending: Map<string, Entry> | undefined;
  private readonly source: ThreadCacheSource;
  constructor(source: ThreadCacheSource, maxEntries = 256, maxBytes = 16 * 1024 * 1024) {
    this.source = source;
    this.entries = new BoundedCache(maxEntries, maxBytes);
  }
  /** The store began its own write transaction; nothing else is open on the connection. */
  begin(): void {
    this.pending = new Map();
  }
  /** A savepoint in it rolled back: rows read since may be undone and their revisions reused. */
  discard(): void {
    this.pending?.clear();
  }
  /** It committed: what it read is committed now. */
  commit(): void {
    for (const [id, entry] of this.pending ?? []) this.store(id, entry);
    this.pending = undefined;
  }
  /** It ended any other way. A no-op after `commit`. */
  end(): void {
    this.pending = undefined;
  }
  /** Shared and deeply frozen; callers that need to change it use `getThread`'s copy. */
  read(id: string): FrozenThread | undefined {
    return this.lookup(id);
  }
  /** The caller's own mutable copy. */
  copy(id: string): Thread | undefined {
    const thread = this.lookup(id);
    return thread && structuredClone(thread);
  }
  /** The shared frozen thread and the caller's own copy of it, from one lookup. */
  checkout(id: string): { base: FrozenThread; thread: Thread } | undefined {
    const base = this.lookup(id);
    return base && { base, thread: structuredClone(base) };
  }
  /**
   * The store's own writer just wrote `written` to this thread's row, which now has
   * `revision` and decodes to `thread`: keep it, so the next read needs no decode. The
   * thread must be cached already (the writer read it first), so the weights of the columns
   * not written are known. Only inside the store's write transaction, under the same rules
   * as a read made there; `thread` becomes the cache's.
   */
  remember(
    id: string,
    revision: number,
    thread: Thread,
    written: Record<string, SQLOutputValue>,
  ): void {
    const before = this.pending?.get(id) ?? this.entries.get(id);
    if (before) this.keep(id, revision, thread, { ...before.weights, ...weigh(written) });
  }
  /** As `remember`, for a thread the writer just created: `row` is every column it wrote. */
  rememberCreated(
    id: string,
    revision: number,
    thread: Thread,
    row: Record<string, SQLOutputValue>,
  ): void {
    this.keep(id, revision, thread, weigh(row));
  }
  private keep(id: string, revision: number, thread: Thread, weights: Record<string, number>) {
    if (!this.pending || this.pending.size >= 64) return;
    this.pending.set(id, { revision, thread: deepFreeze(thread), weights, bytes: total(weights) });
  }
  /** Decode a row read together with its revision, reusing the cached copy for that revision. */
  decode(row: Record<string, SQLOutputValue>, revision: SQLOutputValue | undefined): FrozenThread {
    return this.decodeRow(row, revision);
  }
  private lookup(id: string): Thread | undefined {
    const revision = this.source.revision(id);
    if (revision !== undefined) {
      const hit = this.entries.get(id);
      if (hit?.revision === revision) return hit.thread;
      const pending = this.pending?.get(id);
      if (pending?.revision === revision) return pending.thread;
    }
    const row = this.source.row(id);
    return row ? this.decodeRow(row, row.row_revision) : undefined;
  }
  private decodeRow(
    row: Record<string, SQLOutputValue>,
    revision: SQLOutputValue | undefined,
  ): Thread {
    const id = String(row.id);
    const known = typeof revision === "number" && revision > 0 ? revision : undefined;
    const hit = known === undefined ? undefined : this.entries.get(id);
    if (hit && hit.revision === known) return hit.thread;
    const pending = known === undefined ? undefined : this.pending?.get(id);
    if (pending && pending.revision === known) return pending.thread;
    // Freeze a private clone: parsed output can share nested default objects with the schema.
    const thread = deepFreeze(structuredClone(decodeThreadRow(row)));
    if (known === undefined) return thread;
    const weights = weigh(row);
    const entry = { revision: known, thread, weights, bytes: total(weights) };
    if (this.source.committed()) this.store(id, entry);
    // One transaction touches a few threads; a huge one just stops adding.
    else if (this.pending && this.pending.size < 64) this.pending.set(id, entry);
    return thread;
  }
  private store(id: string, entry: Entry): void {
    this.entries.set(id, entry, entry.bytes);
  }
}

/** Frozen subtrees are already deeply frozen here: every cached value is frozen whole. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Decoded objects run a few times their stored text; the budget only needs to scale with it. */
function weigh(row: Record<string, SQLOutputValue>): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const [column, value] of Object.entries(row))
    weights[column] =
      typeof value === "string"
        ? value.length * 4
        : value instanceof Uint8Array
          ? value.byteLength
          : 8;
  return weights;
}
function total(weights: Readonly<Record<string, number>>): number {
  let bytes = 0;
  for (const weight of Object.values(weights)) bytes += weight;
  return bytes;
}

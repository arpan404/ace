import type { SQLOutputValue } from "node:sqlite";
import type { Thread } from "@ace/protocol";
import { BoundedCache } from "@ace/provider-kit/bounded-cache";
import { decodeThreadRow } from "./thread-row.ts";

export type FrozenThread = DeepReadonly<Thread>;
type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

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
 * Only committed reads are stored. A committed revision is never handed out again: the
 * AUTOINCREMENT high-water mark commits with it. So a hit is the exact row that revision
 * named, even inside a write transaction that later rolls back, and no rollback anywhere
 * on the connection has to remember to clear the cache.
 */
export class ThreadCache {
  /** Deeply frozen at runtime; typed mutable only so `copy` can clone it as a Thread. */
  private readonly entries: BoundedCache<string, { revision: number; thread: Thread }>;
  private readonly source: ThreadCacheSource;
  constructor(source: ThreadCacheSource, maxEntries = 512, maxBytes = 32 * 1024 * 1024) {
    this.source = source;
    this.entries = new BoundedCache(maxEntries, maxBytes);
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
  /** Decode a row read together with its revision, reusing the cached copy for that revision. */
  decode(row: Record<string, SQLOutputValue>, revision: SQLOutputValue | undefined): FrozenThread {
    return this.decodeRow(row, revision);
  }
  private lookup(id: string): Thread | undefined {
    const revision = this.source.revision(id);
    if (revision !== undefined) {
      const hit = this.entries.get(id);
      if (hit?.revision === revision) return hit.thread;
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
    // Freeze a private clone: parsed output can share nested default objects with the schema.
    const thread = deepFreeze(structuredClone(decodeThreadRow(row)));
    if (known !== undefined && this.source.committed())
      this.entries.set(id, { revision: known, thread }, rowBytes(row));
    return thread;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Decoded objects run a few times their stored text; the budget only needs to scale with it. */
function rowBytes(row: Record<string, SQLOutputValue>): number {
  let bytes = 0;
  for (const value of Object.values(row))
    bytes +=
      typeof value === "string"
        ? value.length * 4
        : value instanceof Uint8Array
          ? value.byteLength
          : 8;
  return bytes;
}

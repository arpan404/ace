import { BoundedCache } from "@ace/provider-kit/bounded-cache";

const maxBytes = 8 * 1024 * 1024;
interface Entry {
  value: unknown;
  bytes: number;
  thread: string;
  shared: boolean;
}

/**
 * Committed reads of one thread, each usable until that thread is written or the database
 * changes in a way the store cannot attribute to a thread.
 *
 * `version()` names everything the store did not attribute: other connections' commits
 * (`data_version`) and local rows written outside the event writer. A change to it drops every
 * entry and every held view. A write the store attributes to threads drops only theirs
 * (`evict`), in the commit that made it, before any later read.
 */
export class ThreadReadCache {
  private entries = new BoundedCache<string, Entry>(512, maxBytes, (key, entry) =>
    this.unindex(key, entry.thread),
  );
  private keys = new Map<string, Set<string>>();
  private version = "";
  constructor(privateOptions: {
    flush(): void;
    version(): string;
    inTransaction(): boolean;
    generationChanged(): void;
  }) {
    this.options = privateOptions;
  }
  private readonly options;
  // staleServes exists only to prove a stale entry is never served.
  readonly metrics = {
    hits: 0,
    misses: 0,
    hitBytes: 0,
    invalidations: 0,
    threadEvictions: 0,
    evictions: 0,
    bytes: 0,
    staleServes: 0,
  };
  invalidate(): void {
    this.entries = new BoundedCache<string, Entry>(512, maxBytes, (key, entry) =>
      this.unindex(key, entry.thread),
    );
    this.keys.clear();
    this.metrics.bytes = 0;
    this.metrics.invalidations++;
  }
  /** These threads' rows changed in a commit: their entries no longer describe them. */
  evict(threads: Iterable<string>): void {
    for (const thread of threads) {
      const keys = this.keys.get(thread);
      if (!keys) continue;
      this.keys.delete(thread);
      for (const key of keys) this.entries.delete(key);
      this.metrics.threadEvictions++;
    }
    this.metrics.bytes = this.entries.byteLength;
  }
  /** A read whose callers may change the value: every caller gets its own copy. */
  read<T>(thread: string, key: string, load: () => T): T {
    return this.cached(thread, key, load, false);
  }
  /**
   * A read whose callers never change the value: one deeply frozen value is shared by every
   * caller, so neither a hit nor a miss copies it.
   */
  readShared<T>(thread: string, key: string, load: () => T): T {
    return this.cached(thread, key, load, true);
  }
  private cached<T>(thread: string, key: string, load: () => T, shared: boolean): T {
    this.options.flush();
    // Uncommitted reads neither consume cached values nor change the committed generation.
    if (this.options.inTransaction()) return shared ? deepFreeze(load()) : load();
    const version = this.options.version();
    if (version !== this.version) {
      this.version = version;
      this.invalidate();
      this.options.generationChanged();
    }
    const entryKey = `${thread}\u0000${key}`;
    const cached = this.entries.get(entryKey);
    if (cached !== undefined && cached.shared === shared) {
      this.metrics.hits++;
      this.metrics.hitBytes += cached.bytes;
      // Each key belongs to one typed Store read method.
      return (shared ? cached.value : structuredClone(cached.value)) as T;
    }
    this.metrics.misses++;
    const value = shared ? deepFreeze(load()) : load();
    const bytes = estimatedBytes(value, maxBytes);
    if (bytes <= maxBytes) {
      const stored: Entry = {
        value: shared ? value : structuredClone(value),
        bytes,
        thread,
        shared,
      };
      if (this.entries.set(entryKey, stored, bytes)) {
        let keys = this.keys.get(thread);
        if (!keys) this.keys.set(thread, (keys = new Set()));
        keys.add(entryKey);
      }
      this.metrics.bytes = this.entries.byteLength;
      this.metrics.evictions = this.entries.evictions;
    }
    return value;
  }
  private unindex(key: string, thread: string): void {
    const keys = this.keys.get(thread);
    keys?.delete(key);
    if (keys?.size === 0) this.keys.delete(thread);
  }
}

/**
 * Heap weight of plain data, about what the old measure (JSON bytes x 4) gave, without
 * serialising it. Stops counting once past `limit`.
 */
export function estimatedBytes(value: unknown, limit: number): number {
  let bytes = 0;
  const stack: unknown[] = [value];
  while (stack.length && bytes <= limit) {
    const next = stack.pop();
    if (typeof next === "string") bytes += 16 + next.length * 2;
    else if (typeof next !== "object" || next === null) bytes += 8;
    else if (Array.isArray(next)) {
      bytes += 16 + next.length * 8;
      for (const child of next) stack.push(child);
    } else
      for (const [name, child] of Object.entries(next)) {
        bytes += 16 + name.length * 2;
        stack.push(child);
      }
  }
  return bytes;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

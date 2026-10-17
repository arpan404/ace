import { BoundedCache } from "@ace/provider-kit/bounded-cache";
/** Read entries have their own budget; an entry is usable only in its exact DB generation. */
export class ThreadReadCache {
  private entries = new BoundedCache<string, { value: unknown; bytes: number }>(
    512,
    8 * 1024 * 1024,
  );
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
  // Coarse invalidation (clear-all on any local commit) plus data_version/total_changes
  // fencing means a stale entry can never be served; staleServes exists only to prove it.
  readonly metrics = {
    hits: 0,
    misses: 0,
    hitBytes: 0,
    invalidations: 0,
    evictions: 0,
    bytes: 0,
    staleServes: 0,
  };
  invalidate(): void {
    this.entries.clear();
    this.metrics.bytes = 0;
    this.metrics.invalidations++;
  }
  read<T>(key: string, load: () => T): T {
    this.options.flush();
    // Uncommitted reads neither consume cached values nor change the committed generation.
    if (this.options.inTransaction()) return load();
    const version = this.options.version();
    if (version !== this.version) {
      this.version = version;
      this.invalidate();
      this.options.generationChanged();
    }
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      this.metrics.hits++;
      this.metrics.hitBytes += cached.bytes;
      // Each key belongs to one typed Store read method. Never expose the cached mutable value.
      return structuredClone(cached.value) as T;
    }
    this.metrics.misses++;
    const value = load();
    const bytes = Buffer.byteLength(JSON.stringify(value)) * 4;
    if (bytes <= 8 * 1024 * 1024) {
      this.entries.set(key, { value: structuredClone(value), bytes }, bytes);
      this.metrics.bytes = this.entries.byteLength;
      this.metrics.evictions = this.entries.evictions;
    }
    return value;
  }
}

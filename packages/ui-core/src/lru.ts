/**
 * A cache bounded by entry count and by total weight (bytes, rows, whatever the caller
 * measures), evicting the least recently used entries first. Reading an entry refreshes it.
 * Every cache of derived view data (markdown, highlighting, diffs) goes through one of these so
 * a session that runs for weeks holds a fixed amount, however much it has shown.
 */
export class LruCache<K, V> {
  private entries = new Map<K, { value: V; weight: number }>();
  private total = 0;
  private maxEntries: number;
  private maxWeight: number;
  private weigh: (value: V) => number;
  private dispose: ((value: V) => void) | undefined;
  constructor(options: {
    maxEntries: number;
    maxWeight?: number;
    weigh?: (value: V) => number;
    /**
     * Frees a value the cache drops on its own: evicted, replaced, refused as too heavy or
     * cleared. A value removed with `delete` or `take` is the caller's again and is not freed.
     */
    dispose?: (value: V) => void;
  }) {
    this.maxEntries = options.maxEntries;
    this.maxWeight = options.maxWeight ?? Number.POSITIVE_INFINITY;
    this.weigh = options.weigh ?? (() => 1);
    this.dispose = options.dispose;
  }
  get size(): number {
    return this.entries.size;
  }
  get weight(): number {
    return this.total;
  }
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  has(key: K): boolean {
    return this.entries.has(key);
  }
  /** Store `value`; one heavier than the whole budget is not kept. */
  set(key: K, value: V): void {
    const previous = this.take(key);
    if (previous !== undefined && previous !== value) this.dispose?.(previous);
    const weight = this.weigh(value);
    if (weight > this.maxWeight) return void this.dispose?.(value);
    this.entries.set(key, { value, weight });
    this.total += weight;
    for (const [oldest, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.total <= this.maxWeight) break;
      this.entries.delete(oldest);
      this.total -= entry.weight;
      this.dispose?.(entry.value);
    }
  }
  /** Removes and returns the value under `key`; it is the caller's now. */
  take(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.total -= entry.weight;
    return entry.value;
  }
  delete(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.total -= entry.weight;
  }
  clear(): void {
    const values = [...this.entries.values()];
    this.entries.clear();
    this.total = 0;
    if (this.dispose) for (const { value } of values) this.dispose(value);
  }
}

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
  constructor(options: { maxEntries: number; maxWeight?: number; weigh?: (value: V) => number }) {
    this.maxEntries = options.maxEntries;
    this.maxWeight = options.maxWeight ?? Number.POSITIVE_INFINITY;
    this.weigh = options.weigh ?? (() => 1);
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
    this.delete(key);
    const weight = this.weigh(value);
    if (weight > this.maxWeight) return;
    this.entries.set(key, { value, weight });
    this.total += weight;
    for (const [oldest, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.total <= this.maxWeight) break;
      this.entries.delete(oldest);
      this.total -= entry.weight;
    }
  }
  delete(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.total -= entry.weight;
  }
  clear(): void {
    this.entries.clear();
    this.total = 0;
  }
}

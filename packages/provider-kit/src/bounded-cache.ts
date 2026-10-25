/** LRU with both entry and caller-supplied byte budgets. Pending work belongs outside the cache. */
export class BoundedCache<K, V> {
  private entries = new Map<K, { value: V; bytes: number }>();
  private bytes = 0;
  private evicted = 0;
  private maxEntries: number;
  private maxBytes: number;
  private onEvict: ((key: K, value: V) => void) | undefined;
  /** `onEvict` hears about entries the budget pushed out; explicit deletes are not reported. */
  constructor(maxEntries: number, maxBytes: number, onEvict?: (key: K, value: V) => void) {
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1
    )
      throw new Error("Invalid cache budget");
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.onEvict = onEvict;
  }
  get byteLength(): number {
    return this.bytes;
  }
  get evictions(): number {
    return this.evicted;
  }
  get size(): number {
    return this.entries.size;
  }
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  /** False when the value alone exceeds the byte budget, so nothing was kept. */
  set(key: K, value: V, bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid cache weight");
    this.delete(key);
    if (bytes > this.maxBytes) return false;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.entries().next();
      if (oldest.done) break;
      const [evictedKey, entry] = oldest.value;
      this.delete(evictedKey);
      this.evicted++;
      this.onEvict?.(evictedKey, entry.value);
    }
    return true;
  }
  delete(key: K): void {
    const entry = this.entries.get(key);
    if (entry) {
      this.bytes -= entry.bytes;
      this.entries.delete(key);
    }
  }
  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

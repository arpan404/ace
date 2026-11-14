/**
 * A cache bounded by entry count and by weight (bytes), least recently used out first. A value
 * is owned by the cache while it is in it: one evicted, replaced or cleared is handed to
 * `dispose`, and one taken out belongs to the caller again.
 */
export interface LruBounds {
  entries: number;
  bytes: number;
}

export class BoundedLru<V> {
  readonly #bounds: LruBounds;
  readonly #dispose: (value: V) => void;
  // Map order is insertion order: the first key is the least recently used.
  readonly #entries = new Map<string, { value: V; bytes: number }>();
  #bytes = 0;

  constructor(bounds: LruBounds, dispose: (value: V) => void) {
    this.#bounds = bounds;
    this.#dispose = dispose;
  }

  get size(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  /** Whether `key` is held and its value passes `fits`, without taking or touching it. */
  has(key: string, fits: (value: V) => boolean = () => true): boolean {
    const entry = this.#entries.get(key);
    return entry !== undefined && fits(entry.value);
  }

  /** Removes and returns the value under `key`; the caller owns it now. */
  take(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
    return entry.value;
  }

  /** Holds `value` as the most recently used, evicting the oldest until within bounds. */
  put(key: string, value: V, bytes: number): void {
    const previous = this.take(key);
    if (previous !== undefined && previous !== value) this.#dispose(previous);
    if (bytes > this.#bounds.bytes || this.#bounds.entries <= 0) {
      this.#dispose(value);
      return;
    }
    this.#entries.set(key, { value, bytes });
    this.#bytes += bytes;
    while (this.#entries.size > this.#bounds.entries || this.#bytes > this.#bounds.bytes) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.take(oldest);
      if (evicted !== undefined) this.#dispose(evicted);
    }
  }

  clear(): void {
    const values = [...this.#entries.values()];
    this.#entries.clear();
    this.#bytes = 0;
    for (const { value } of values) this.#dispose(value);
  }
}

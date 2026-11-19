/**
 * The last `size` ids seen, to drop a message that arrives twice (one alert carried by both the
 * old and the new path while a path switch drains, ADR 0114). Bounded: the oldest id goes first.
 */
export class RecentIds {
  #ids = new Set<string>();
  #size: number;
  constructor(size: number) {
    this.#size = size;
  }
  /** True when `id` was already seen; otherwise remembers it. */
  seen(id: string): boolean {
    if (this.#ids.has(id)) return true;
    this.#ids.add(id);
    if (this.#ids.size > this.#size) {
      const oldest = this.#ids.values().next().value;
      if (oldest !== undefined) this.#ids.delete(oldest);
    }
    return false;
  }
}

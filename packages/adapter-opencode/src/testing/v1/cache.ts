/** A reconciliation window. Live entities are kept separately by their owner. */
export class RecentMap<T> extends Map<string, T> {
  readonly limit: number;
  constructor(limit: number) {
    super();
    this.limit = limit;
  }
  override set(key: string, value: T): this {
    this.delete(key);
    super.set(key, value);
    if (this.size > this.limit) {
      const first = this.keys().next().value;
      if (first !== undefined) this.delete(first);
    }
    return this;
  }
}
export class RecentSet extends Set<string> {
  override add(key: string): this {
    super.add(key);
    if (this.size > 1024) {
      const first = this.values().next().value;
      if (first !== undefined) this.delete(first);
    }
    return this;
  }
}

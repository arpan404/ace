import { immutable } from "./immutable.ts";

export type Changes<T> = { upsert: readonly T[]; removed: readonly T[] };
type Version<T> = { previous: object; changes: Changes<T> };
/** Weak revision metadata never owns a chain of historical snapshots. */
export class CollectionVersions<T> {
  readonly #identities = new WeakMap<T[], object>();
  readonly #versions = new WeakMap<T[], Version<T>>();
  retain(previous: T[], next: T[], changes: Changes<T>): T[] {
    this.#identity(next);
    this.#versions.set(next, { previous: this.#identity(previous), changes: immutable(changes) });
    return immutable(next);
  }
  #identity(items: T[]): object {
    const known = this.#identities.get(items);
    if (known) return known;
    const identity = {};
    this.#identities.set(items, identity);
    return identity;
  }
  changes(previous: T[], next: T[], identity: (item: T) => string): Changes<T> {
    if (previous === next) return { upsert: [], removed: [] };
    const known = this.#versions.get(next);
    if (known && known.previous === this.#identities.get(previous)) return known.changes;
    // Full snapshots from other Forge implementations carry no delta information.
    const before = new Map(previous.map((item) => [identity(item), item]));
    const upsert: T[] = [];
    for (const item of next) {
      const key = identity(item);
      if (before.get(key) !== item) upsert.push(item);
      before.delete(key);
    }
    return { upsert, removed: [...before.values()] };
  }
}

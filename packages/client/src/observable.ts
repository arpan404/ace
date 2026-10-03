import { ClientError } from "./types.ts";
export interface Selection<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}
/** Explicit keys keep unrelated selectors out of the event hot path. */
export class Notifications {
  private keys = new Map<string, Set<() => void>>();
  private count = 0;
  private limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  select<T>(
    keys: readonly string[],
    read: () => T,
    equal: (a: T, b: T) => boolean = Object.is,
  ): Selection<T> {
    let value = read();
    return {
      getSnapshot: () => {
        const next = read();
        if (!equal(value, next)) value = next;
        return value;
      },
      subscribe: (listener) => {
        if (this.count + keys.length > this.limit) throw new ClientError("limit");
        let previous = read();
        const update = () => {
          const next = read();
          if (!equal(previous, next)) {
            previous = next;
            value = next;
            listener();
          }
        };
        for (const key of keys) {
          let set = this.keys.get(key);
          if (!set) {
            set = new Set();
            this.keys.set(key, set);
          }
          set.add(update);
          this.count++;
        }
        let stopped = false;
        return () => {
          if (stopped) return;
          stopped = true;
          for (const key of keys) {
            const set = this.keys.get(key);
            set?.delete(update);
            if (!set?.size) this.keys.delete(key);
            this.count--;
          }
        };
      },
    };
  }
  emit(keys: Iterable<string>): void {
    const updates = new Set<() => void>();
    for (const key of keys) for (const listener of this.keys.get(key) ?? []) updates.add(listener);
    for (const update of updates) {
      try {
        update();
      } catch {
        /* An observer cannot stop committed state delivery. */
      }
    }
  }
  emitAll(): void {
    this.emit(this.keys.keys());
  }
}

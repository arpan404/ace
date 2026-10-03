import { ClientError } from "./types.ts";
export interface Selection<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}
/** Explicit keys keep unrelated selectors out of the event hot path. */
/** Every change a store announces: its keys, or "all" after a snapshot replaced everything. */
export type ChangeTap = (keys: ReadonlySet<string> | "all") => void;
export class Notifications {
  private keys = new Map<string, Set<() => void>>();
  private taps = new Set<ChangeTap>();
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
  /** Observe every emitted key, listened to or not (a worker forwarding changes to tabs). */
  tap(listener: ChangeTap): () => void {
    this.taps.add(listener);
    return () => this.taps.delete(listener);
  }
  emit(keys: Iterable<string>): void {
    const changed: ReadonlySet<string> = keys instanceof Set ? keys : new Set(keys);
    if (this.taps.size) this.announce(changed);
    const updates = new Set<() => void>();
    for (const key of changed)
      for (const listener of this.keys.get(key) ?? []) updates.add(listener);
    run(updates);
  }
  emitAll(): void {
    this.announce("all");
    const updates = new Set<() => void>();
    for (const set of this.keys.values()) for (const listener of set) updates.add(listener);
    run(updates);
  }
  private announce(keys: ReadonlySet<string> | "all"): void {
    for (const tap of this.taps) {
      try {
        tap(keys);
      } catch {
        /* A tap cannot stop committed state delivery. */
      }
    }
  }
}
function run(updates: ReadonlySet<() => void>): void {
  for (const update of updates) {
    try {
      update();
    } catch {
      /* An observer cannot stop committed state delivery. */
    }
  }
}

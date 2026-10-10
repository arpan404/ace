import { ClientError } from "./types.ts";
export interface Selection<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}
/** Explicit keys keep unrelated selectors out of the event hot path. */
/** Every change a store announces: its keys, or "all" after a snapshot replaced everything. */
export type ChangeTap = (keys: ReadonlySet<string> | "all") => void;
export class Notifications {
  #keys = new Map<string, Set<() => void>>();
  #taps = new Set<ChangeTap>();
  #count = 0;
  /** Bumped by every emit; an unsubscribed selection reads again only after one. */
  #version = 0;
  #limit: number;
  constructor(limit: number) {
    this.#limit = limit;
  }
  select<T>(
    keys: readonly string[],
    read: () => T,
    equal: (a: T, b: T) => boolean = Object.is,
  ): Selection<T> {
    let value = read();
    let readAt = this.#version;
    let subscribers = 0;
    // React reads a snapshot on every render. A subscribed selection is brought up to date by
    // its keys as they change, so a render with nothing new costs nothing; an unsubscribed one
    // reads again only if the store changed since.
    const current = () => {
      if (subscribers > 0 || readAt === this.#version) return value;
      readAt = this.#version;
      const next = read();
      if (!equal(value, next)) value = next;
      return value;
    };
    return {
      getSnapshot: current,
      subscribe: (listener) => {
        if (this.#count + keys.length > this.#limit) throw new ClientError("limit");
        let previous = current();
        subscribers++;
        const update = () => {
          const next = read();
          if (!equal(previous, next)) {
            previous = next;
            value = next;
            listener();
          }
        };
        for (const key of keys) {
          let set = this.#keys.get(key);
          if (!set) {
            set = new Set();
            this.#keys.set(key, set);
          }
          set.add(update);
          this.#count++;
        }
        let stopped = false;
        return () => {
          if (stopped) return;
          stopped = true;
          // Current as of now: the keys kept it so until this moment.
          subscribers--;
          readAt = this.#version;
          for (const key of keys) {
            const set = this.#keys.get(key);
            set?.delete(update);
            if (!set?.size) this.#keys.delete(key);
            this.#count--;
          }
        };
      },
    };
  }
  /** Observe every emitted key, listened to or not (a worker forwarding changes to tabs). */
  tap(listener: ChangeTap): () => void {
    this.#taps.add(listener);
    return () => this.#taps.delete(listener);
  }
  emit(keys: Iterable<string>): void {
    this.#version++;
    const changed: ReadonlySet<string> = keys instanceof Set ? keys : new Set(keys);
    if (this.#taps.size) this.#announce(changed);
    const updates = new Set<() => void>();
    for (const key of changed)
      for (const listener of this.#keys.get(key) ?? []) updates.add(listener);
    notifyObservers(updates, undefined);
  }
  emitAll(): void {
    this.#version++;
    this.#announce("all");
    const updates = new Set<() => void>();
    for (const set of this.#keys.values()) for (const listener of set) updates.add(listener);
    notifyObservers(updates, undefined);
  }
  #announce(keys: ReadonlySet<string> | "all"): void {
    notifyObservers(this.#taps, keys);
  }
}
/** Consumer exceptions cannot interrupt delivery of already committed facts. */
export function notifyObservers<T>(observers: Iterable<(value: T) => void>, value: T): void {
  for (const observer of observers) {
    try {
      observer(value);
    } catch {
      /* An observer cannot stop committed state delivery. */
    }
  }
}

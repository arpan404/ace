import type { ReadSnapshotStorage } from "./read-snapshot-storage.ts";
import type { Scheduler } from "./types.ts";

export type { ReadSnapshotStorage } from "./read-snapshot-storage.ts";

/** Where views keep their read snapshots, and the clock that paces the writes. */
export interface Persistence {
  storage: ReadSnapshotStorage;
  scheduler: Scheduler;
}

/** A store's changes are written at most once per this many milliseconds. */
export const snapshotWriteMs = 1_000;

/**
 * One store's read snapshot on disk (ADR 0030). The snapshot is read once: `restore` gets it
 * unless the store changed first (a live snapshot already arrived, or the store failed). After
 * a change, the store is read and written once the interval has passed, never on the
 * notification path, and a change during a write waits for that write. `close` stops following
 * and checkpoints what is still unwritten after any write in flight, so the newest copy lands
 * last.
 */
export class SnapshotBinding {
  #persistence: Persistence;
  #key: string;
  #read: () => unknown;
  #unfollow: () => void;
  #closed = false;
  #changed = false;
  #dirty = false;
  #writing = false;
  #cancel: (() => void) | undefined;
  #written: Promise<void> = Promise.resolve();

  constructor(
    persistence: Persistence,
    key: string,
    /** Calls `changed` whenever the store's content changes; returns how to stop. */
    follow: (changed: () => void) => () => void,
    /** The record to keep, or undefined when there is nothing worth keeping. */
    read: () => unknown,
    restore: (value: unknown) => void,
  ) {
    this.#persistence = persistence;
    this.#key = key;
    this.#read = read;
    this.#unfollow = follow(() => {
      this.#changed = true;
      this.#dirty = true;
      this.#schedule();
    });
    let loaded: Promise<unknown>;
    try {
      loaded = persistence.storage.get(key);
    } catch {
      loaded = Promise.resolve(undefined);
    }
    void loaded.then(
      (value) => {
        if (this.#closed || this.#changed || value === undefined) return;
        restore(value);
      },
      () => {},
    );
  }

  #schedule(): void {
    if (this.#closed || this.#cancel || this.#writing) return;
    this.#cancel = this.#persistence.scheduler.set(snapshotWriteMs, () => {
      this.#cancel = undefined;
      this.#write();
    });
  }

  #write(): void {
    this.#dirty = false;
    let value: unknown;
    try {
      value = this.#read();
    } catch {
      return;
    }
    if (value === undefined) return;
    this.#writing = true;
    // `set` copies the record before it yields, so later frames cannot reach the disk copy.
    this.#written = this.#store(value).finally(() => {
      this.#writing = false;
      if (this.#dirty) this.#schedule();
    });
  }

  #store(value: unknown): Promise<void> {
    try {
      return this.#persistence.storage.set(this.#key, value).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  close(): Promise<void> {
    if (this.#closed) return this.#written;
    this.#closed = true;
    this.#cancel?.();
    this.#cancel = undefined;
    this.#unfollow();
    if (!this.#dirty) return this.#written;
    let value: unknown;
    try {
      // Copied now: the store may still take frames while the write in flight finishes.
      value = structuredClone(this.#read());
    } catch {
      return this.#written;
    }
    this.#dirty = false;
    if (value === undefined) return this.#written;
    this.#written = this.#written.then(() => this.#store(value));
    return this.#written;
  }
}

/** Follow `observe`'s content changes: a change to the syncing flag alone is not content. */
export function contentChanges(
  observe: (tap: (keys: ReadonlySet<string> | "all") => void) => () => void,
): (changed: () => void) => () => void {
  return (changed) =>
    observe((keys) => {
      if (keys === "all") return changed();
      for (const key of keys) if (key !== "sync") return changed();
    });
}

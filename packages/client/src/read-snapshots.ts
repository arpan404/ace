import type { ReadSnapshotStorage } from "./read-snapshot-storage.ts";
import type { Scheduler } from "./types.ts";

export type { ReadSnapshotStorage } from "./read-snapshot-storage.ts";

/** Where views keep their read snapshots, and the clock that paces the writes. */
export interface Persistence {
  storage: ReadSnapshotStorage;
  scheduler: Scheduler;
  /**
   * Settles once the client has had a daemon's welcome (and stays settled). Until then nothing
   * a subscription asks for can be answered, so a kept record still being read is waited for
   * until it. None: the wait is `firstReadMs` from the binding's start.
   */
  welcomed?(): Promise<void>;
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
/**
 * How long a new subscription waits for its kept record before it goes without one, unless the
 * client has not had its first welcome by then: it then waits until the welcome, and no longer.
 * A record read before the welcome costs nothing (the subscribe still goes ahead of it, with
 * its cursor); one still unread at the welcome goes without it, as a subscribe after the
 * welcome always went. A relaunch reads a cold store, and opening without what it kept costs a
 * full snapshot.
 */
export const firstReadMs = 250;

export class SnapshotBinding {
  #persistence: Persistence;
  #key: string;
  #read: () => unknown;
  #unfollow: () => void;
  #closed = false;
  #discarded = false;
  #changed = false;
  #dirty = false;
  #writing = false;
  #cancel: (() => void) | undefined;
  #written: Promise<void> = Promise.resolve();
  /**
   * Settles once the first read of the kept record has been tried (restored, missed or failed),
   * or at the later of `firstReadMs` after this start and the client's first welcome, so a
   * subscription can resume from what it held (ADR 0128).
   */
  readonly loaded: Promise<void>;
  /** Settles once the first read of the kept record has been tried, however long it takes. */
  readonly read: Promise<void>;

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
    const tried = loaded.then(
      (value) => {
        if (this.#closed || this.#changed || value === undefined) return;
        restore(value);
      },
      () => {},
    );
    this.read = tried;
    this.loaded = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        cancel();
        resolve();
      };
      // Gives up at the later of `firstReadMs` after this start and the client's first welcome.
      let waited = false;
      let welcomed = persistence.welcomed === undefined;
      const giveUp = () => {
        if (waited && welcomed) finish();
      };
      const cancel = persistence.scheduler.set(firstReadMs, () => {
        waited = true;
        giveUp();
      });
      // A welcome that fails leaves the wait to the deadline above.
      void persistence
        .welcomed?.()
        .then(() => {
          welcomed = true;
          giveUp();
        })
        .catch(() => {});
      // The read settles found or not; one that cannot be painted leaves the deadline above.
      void tried.then(finish).catch(() => {});
    });
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
    if (this.#discarded) return Promise.resolve();
    try {
      return this.#persistence.storage.set(this.#key, value).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  /**
   * Stop following and write nothing more, including a checkpoint `close` left waiting behind a
   * write in flight: the record is being dropped. A write already handed to storage still lands
   * first, so a delete asked after this one wins.
   */
  discard(): void {
    this.#discarded = true;
    if (this.#closed) return;
    this.#closed = true;
    this.#cancel?.();
    this.#cancel = undefined;
    this.#dirty = false;
    this.#unfollow();
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

/** Follow `observe`'s content changes: the syncing and unconfirmed flags are not content. */
export function contentChanges(
  observe: (tap: (keys: ReadonlySet<string> | "all") => void) => () => void,
): (changed: () => void) => () => void {
  return (changed) =>
    observe((keys) => {
      if (keys === "all") return changed();
      for (const key of keys) if (key !== "sync" && key !== "unconfirmed") return changed();
    });
}

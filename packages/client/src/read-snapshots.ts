import type { Scheduler } from "./types.ts";
import type { ReadSnapshotStorage } from "./read-snapshot-storage.ts";
export type { ReadSnapshotStorage } from "./read-snapshot-storage.ts";

/** Serialization happens at most once per interval, never on the delta notification path. */
export class SnapshotBinding {
  #cancel: (() => void) | undefined;
  #stop: () => void;
  #closed = false;
  #revision = 0;
  #writing = false;
  #dirty = false;
  #written: Promise<void> = Promise.resolve();
  #checkpoint: () => Promise<void>;
  constructor(
    storage: ReadSnapshotStorage,
    scheduler: Scheduler,
    key: string,
    observe: (changed: () => void) => () => void,
    read: () => unknown,
    hydrate: (value: unknown) => void,
  ) {
    const schedule = () => {
      if (this.#closed || this.#cancel || this.#writing) return;
      this.#cancel = scheduler.set(1_000, () => {
        this.#cancel = undefined;
        this.#dirty = false;
        this.#writing = true;
        // Capture at the scheduled boundary, before another stream frame or close can run.
        let write: Promise<void>;
        try {
          write = storage.set(key, read());
        } catch {
          write = Promise.resolve();
        }
        this.#written = write
          .catch(() => {})
          .finally(() => {
            this.#writing = false;
            if (this.#dirty) schedule();
          });
      });
    };
    this.#checkpoint = () => {
      if (!this.#dirty) return this.#written;
      // Capture before yielding: the store may still receive frames during shutdown.
      // Clear only after serializing: a transient failure keeps the write dirty for the next pass.
      let serialized: string;
      try {
        serialized = JSON.stringify(read());
      } catch {
        return this.#written;
      }
      this.#dirty = false;
      this.#written = this.#written
        .then(() => {
          const value: unknown = JSON.parse(serialized);
          return storage.set(key, value);
        })
        .catch(() => {});
      return this.#written;
    };
    this.#stop = observe(() => {
      this.#revision++;
      this.#dirty = true;
      schedule();
    });
    let loaded: Promise<unknown>;
    try {
      loaded = storage.get(key);
    } catch {
      loaded = Promise.resolve(undefined);
    }
    void loaded
      .then((value) => {
        if (this.#closed || this.#revision || value === undefined) return;
        hydrate(value);
      })
      .catch(() => {});
  }
  close(): Promise<void> {
    if (this.#closed) return this.#written;
    this.#closed = true;
    this.#cancel?.();
    this.#cancel = undefined;
    this.#stop();
    return this.#checkpoint();
  }
}

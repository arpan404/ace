/**
 * One buffer's writes to its draft on the device. Each write (a put or a delete) is decided by
 * the caller when asked and handed to the store at once: it starts before the caller returns, so
 * a page that is hiding gets it under way, and a buffer freed meanwhile can't skip it. The store
 * applies writes in the order they are made (IndexedDB runs readwrite transactions on one store
 * in creation order), so an older put never lands after a newer delete. Whether the draft is
 * kept is the answer of the newest write.
 */
export class DraftSlot {
  readonly #running = new Set<Promise<void>>();
  #made = 0;
  readonly #kept: (kept: boolean) => void;

  /** `kept` hears the newest write's outcome: false when the device couldn't store it. */
  constructor(kept: (kept: boolean) => void) {
    this.#kept = kept;
  }

  /** A write is out: the device may not have the newest text yet. */
  get pending(): boolean {
    return this.#running.size > 0;
  }

  /**
   * Starts `write` now. A failed write counts as kept when `failureKeeps` (a delete the person
   * asked for: an unreachable store changes nothing). Never rejects.
   */
  write(write: () => Promise<void>, failureKeeps = false): Promise<void> {
    const made = ++this.#made;
    let started: Promise<void>;
    try {
      started = write();
    } catch (error) {
      started = Promise.reject(error);
    }
    const done = started
      .then(
        () => true,
        () => failureKeeps,
      )
      .then((kept) => {
        this.#running.delete(done);
        if (made === this.#made) this.#kept(kept);
      });
    this.#running.add(done);
    return done;
  }

  /** Resolves once every write made so far has finished. */
  async settled(): Promise<void> {
    await Promise.all(this.#running);
  }
}

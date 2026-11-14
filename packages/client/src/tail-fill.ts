/**
 * Fills threads opened from a small tail (`ClientOptions.openTail`) in the background: one
 * `items.fill` read each, for what a full snapshot holds beyond the screenful painted. A failed
 * read leaves the thread as it is; scrolling up still pages older items in. One fill per thread
 * at a time.
 */
export class TailFill {
  #running = new Set<string>();
  #fill: (threadId: string) => Promise<void>;
  constructor(fill: (threadId: string) => Promise<void>) {
    this.#fill = fill;
  }
  start(threadId: string): void {
    if (this.#running.has(threadId)) return;
    this.#running.add(threadId);
    void this.#fill(threadId)
      .catch(() => {})
      .finally(() => this.#running.delete(threadId));
  }
}

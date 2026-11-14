import type { ThreadStore } from "./thread-store.ts";

/** Items asked for per background page: small enough that each one paints soon on a slow link. */
export const fillPageItems = 50;

/**
 * Page a thread opened with a small tail back up to `capacity` items, one page at a time, in
 * the background. It stops when the thread's start is reached, the window is full, nobody holds
 * the thread any more, or a page fails or moves nothing (a later scroll pages on from there).
 * One fill per thread at a time.
 */
export class TailFill {
  #running = new Set<string>();
  #held: (threadId: string) => ThreadStore | undefined;
  #older: (threadId: string, limit: number) => Promise<void>;
  #capacity: number;
  constructor(
    held: (threadId: string) => ThreadStore | undefined,
    older: (threadId: string, limit: number) => Promise<void>,
    capacity: number,
  ) {
    this.#held = held;
    this.#older = older;
    this.#capacity = capacity;
  }
  start(threadId: string): void {
    if (this.#running.has(threadId)) return;
    this.#running.add(threadId);
    void this.#run(threadId).finally(() => this.#running.delete(threadId));
  }
  async #run(threadId: string): Promise<void> {
    for (;;) {
      const store = this.#held(threadId);
      const before = store?.itemsBefore;
      if (!store || before === null || before === undefined) return;
      const room = this.#capacity - store.order.length;
      if (room <= 0) return;
      try {
        await this.#older(threadId, Math.min(fillPageItems, room));
      } catch {
        return;
      }
      if (this.#held(threadId)?.itemsBefore === before) return;
    }
  }
}

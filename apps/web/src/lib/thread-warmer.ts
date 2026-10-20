import type { ClientApi } from "@ace/client";

/** How long a thread the person pointed at stays followed without being opened. */
export const warmHoldMs = 20_000;
/** At most this many at once; pointing at another lets the oldest go. */
export const warmThreads = 3;

type Schedule = (delayMs: number, run: () => void) => () => void;

interface Warm {
  release(): void;
  cancel(): void;
}

/**
 * Threads the person is about to open (a row under the pointer, focused or touched), followed
 * for a short while before they are, so opening one paints at once instead of waiting a round
 * trip for its first snapshot. A hold is an ordinary lease: when it ends, the client keeps the
 * store it filled (marked syncing and unconfirmed, ADR 0030) and the opened view paints from it.
 */
export class ThreadWarmer {
  #client: Pick<ClientApi, "thread">;
  #schedule: Schedule;
  #held = new Map<string, Warm>();

  constructor(client: Pick<ClientApi, "thread">, schedule: Schedule) {
    this.#client = client;
    this.#schedule = schedule;
  }

  warm(threadId: string): void {
    const held = this.#held.get(threadId);
    if (held) {
      // Pointed at again: the newest, and its time starts over.
      held.cancel();
      this.#held.delete(threadId);
      this.#held.set(threadId, { ...held, cancel: this.#expire(threadId) });
      return;
    }
    let release: () => void;
    try {
      ({ release } = this.#client.thread(threadId));
    } catch {
      // Closed, at its subscription limit, or not a thread id: opening it simply loads it.
      return;
    }
    this.#held.set(threadId, { release, cancel: this.#expire(threadId) });
    for (const [id] of this.#held) {
      if (this.#held.size <= warmThreads) break;
      this.#end(id);
    }
  }

  #expire(threadId: string): () => void {
    return this.#schedule(warmHoldMs, () => this.#end(threadId));
  }

  #end(threadId: string): void {
    const held = this.#held.get(threadId);
    if (!held) return;
    this.#held.delete(threadId);
    held.cancel();
    held.release();
  }
}

const warmers = new WeakMap<object, ThreadWarmer>();

/** Follow `threadId` for a moment on `client`, ahead of the person opening it. */
export function warmThread(client: ClientApi, threadId: string): void {
  let warmer = warmers.get(client);
  if (!warmer) {
    // Boundary code: the hold's timer is the browser's.
    warmer = new ThreadWarmer(client, (delayMs, run) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    });
    warmers.set(client, warmer);
  }
  warmer.warm(threadId);
}

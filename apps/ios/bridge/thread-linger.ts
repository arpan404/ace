/*
 * Threads the person just left stay followed a while (ADR 0146). Reopening one then paints what
 * changed meanwhile at once, instead of showing the kept copy until a fresh subscription replays
 * it. Each hold is optional, so it takes only a spare subscription slot and gives way to any
 * thread the person opens.
 */

/** How long a left thread stays followed. */
export const lingerMs = 5 * 60_000;
/** As many as native keeps on its shelf (`ThreadShelf.swift`). */
export const lingerLimit = 6;

export interface LingerHold {
  release(): void;
}
export type LingerSchedule = (delayMs: number, run: () => void) => () => void;

export class ThreadLinger {
  readonly #schedule: LingerSchedule;
  /** Oldest first. */
  readonly #held = new Map<string, { hold: LingerHold; cancel: () => void }>();

  constructor(schedule: LingerSchedule) {
    this.#schedule = schedule;
  }

  /**
   * `threadId` is being left: follow it a while longer through `hold`, which must be taken
   * before the visit lets its own lease go, so the subscription never drops in between.
   */
  keep(threadId: string, hold: LingerHold): void {
    this.drop(threadId);
    const cancel = this.#schedule(lingerMs, () => this.drop(threadId));
    this.#held.set(threadId, { hold, cancel });
    for (const oldest of this.#held.keys()) {
      if (this.#held.size <= lingerLimit) break;
      this.drop(oldest);
    }
  }

  /** Opened again (its visit holds it now), or no longer worth following. */
  drop(threadId: string): void {
    const held = this.#held.get(threadId);
    if (!held) return;
    this.#held.delete(threadId);
    held.cancel();
    held.hold.release();
  }

  clear(): void {
    for (const threadId of this.#held.keys()) this.drop(threadId);
  }
}

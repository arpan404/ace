import { ClientError } from "./types.ts";

/** What one fill attempt came to (`ThreadStore.fill`), or "absent" when none is owed. */
export type FillResult = "applied" | "ignored" | "stale" | "absent";

export interface TailFillPorts {
  /** One `items.fill` read for the thread, merged into its store. */
  fill(threadId: string): Promise<FillResult>;
  /** The thread's store is held and still owed the rest of a full snapshot (`filling`). */
  owed(threadId: string): boolean;
  /** The thread's store can still ask for its fill (it has evicted nothing since its snapshot). */
  askable(threadId: string): boolean;
  /** Resubscribe the thread for the full snapshot, which needs no fill. */
  full(threadId: string): void;
  delay(milliseconds: number, run: () => void): () => void;
}

interface FillState {
  attempts: number;
  running: boolean;
  /** Cancels the retry scheduled, while one waits. */
  cancel: (() => void) | undefined;
}

/** Fill attempts that may fail or come back stale before the thread takes the full snapshot. */
export const fillAttempts = 3;
const firstRetryMs = 500;
const lastRetryMs = 8_000;

/**
 * Fills threads opened from a small tail (`ClientOptions.openTail`) in the background, so no
 * thread rests looking complete while it holds less than a full snapshot:
 * - a fill that fails, or whose answer is stale, is retried with backoff while the thread stays
 *   held and owed;
 * - a fill cut off by the connection waits for the next one: the resubscription's ready asks
 *   again (`start`);
 * - after `fillAttempts` attempts, or once the store can no longer ask (it has evicted items
 *   since its snapshot), the thread resubscribes for the full snapshot, as an open without a
 *   tail does.
 */
export class TailFill {
  #ports: TailFillPorts;
  /** Per thread: attempts so far, and the retry scheduled, if any. */
  #threads = new Map<string, FillState>();
  constructor(ports: TailFillPorts) {
    this.#ports = ports;
  }
  /** Fill `threadId` if it is owed one; a call while one runs or waits does nothing. */
  start(threadId: string): void {
    const state = this.#threads.get(threadId) ?? { attempts: 0, running: false, cancel: undefined };
    if (state.running || state.cancel) return;
    this.#threads.set(threadId, state);
    void this.#run(threadId, state);
  }
  async #run(threadId: string, state: FillState): Promise<void> {
    if (!this.#ports.owed(threadId)) {
      this.#threads.delete(threadId);
      return;
    }
    if (!this.#ports.askable(threadId)) return this.#fallBack(threadId);
    state.running = true;
    let result: FillResult | "failed";
    try {
      result = await this.#ports.fill(threadId);
    } catch (error) {
      // Cut off with the connection: the resubscription's ready starts the fill again.
      if (error instanceof ClientError && error.code === "offline") {
        state.running = false;
        return;
      }
      result = "failed";
    }
    state.running = false;
    if (!this.#ports.owed(threadId)) {
      this.#threads.delete(threadId);
      return;
    }
    // Another snapshot came meanwhile with a fill of its own: ask for that one.
    if (result === "ignored" || result === "applied" || result === "absent")
      return this.#run(threadId, state);
    if (++state.attempts >= fillAttempts) return this.#fallBack(threadId);
    const wait = Math.min(lastRetryMs, firstRetryMs * 2 ** (state.attempts - 1));
    state.cancel = this.#ports.delay(wait, () => {
      state.cancel = undefined;
      void this.#run(threadId, state);
    });
  }
  #fallBack(threadId: string): void {
    this.#threads.get(threadId)?.cancel?.();
    this.#threads.delete(threadId);
    this.#ports.full(threadId);
  }
}

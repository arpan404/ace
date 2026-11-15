import { supervisionTimings } from "./supervision-policy.ts";

export type HungCause = "missed-pongs" | "normal-lane-stalled";

/**
 * Liveness of one ace-media process, from pings on its normal lane.
 *
 * - A ping's deadline starts when its bytes are written, not when it is queued, so a normal
 *   lane that is merely backpressured never counts as missed pongs. While a ping waits to be
 *   written no other is queued behind it.
 * - Three missed pongs in a row mean the process is hung.
 * - A process that stops reading altogether is caught separately: normal-lane bytes pending
 *   and no write completing across six ping intervals (30 s after the first tick that saw it).
 */
export class LaneHealth {
  readonly #timer: (ms: number, callback: () => void) => () => void;
  readonly #onHung: (cause: HungCause) => void;
  readonly #deadlines = new Map<number, () => void>();
  #seq = 0;
  #queued = false;
  #missed = 0;
  #stalled = 0;
  #lastCompleted = -1;

  constructor(
    timer: (ms: number, callback: () => void) => () => void,
    onHung: (cause: HungCause) => void,
  ) {
    this.#timer = timer;
    this.#onHung = onHung;
  }

  /**
   * One ping tick, given the normal lane's progress. Returns the id of the ping to send now, or
   * undefined when the previous one is still unwritten or the process was found hung.
   */
  tick(progress: { pending: number; completed: number }): string | undefined {
    const moving = progress.pending === 0 || progress.completed !== this.#lastCompleted;
    this.#stalled = moving ? 0 : this.#stalled + 1;
    this.#lastCompleted = progress.completed;
    if (this.#stalled >= supervisionTimings.stalledTicks) {
      this.#onHung("normal-lane-stalled");
      return undefined;
    }
    if (this.#queued) return undefined;
    this.#queued = true;
    return `ping-${++this.#seq}`;
  }

  /** The ping's bytes reached the process; its pong deadline starts now. */
  written(id: string): void {
    this.#queued = false;
    const seq = parse(id);
    if (seq === undefined) return;
    this.#deadlines.set(
      seq,
      this.#timer(supervisionTimings.pongMs, () => {
        this.#deadlines.delete(seq);
        if (++this.#missed >= supervisionTimings.missedPongs) this.#onHung("missed-pongs");
      }),
    );
  }

  /** A pong answers its ping and every earlier one. */
  pong(id: string): void {
    const seq = parse(id);
    if (seq === undefined) return;
    this.#missed = 0;
    for (const [pending, cancel] of this.#deadlines)
      if (pending <= seq) {
        cancel();
        this.#deadlines.delete(pending);
      }
  }
}

function parse(id: string): number | undefined {
  const match = /^ping-(\d+)$/.exec(id);
  return match ? Number(match[1]) : undefined;
}

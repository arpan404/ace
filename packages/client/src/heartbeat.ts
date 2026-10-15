import type { Scheduler } from "./types.ts";

interface HeartbeatEvents {
  /** Send a ping; false if it couldn't go out, which ends the beat. */
  ping(): boolean;
  /** A ping went a whole interval without its pong. */
  missed(): void;
}

/**
 * Liveness of a ready socket: every interval it pings, and a ping still unanswered at the next
 * interval means the socket is dead even if it never closed.
 */
export class Heartbeat {
  #scheduler: Scheduler;
  #intervalMs: number;
  #cancel: (() => void) | undefined;
  #awaitingPong = false;
  constructor(scheduler: Scheduler, intervalMs: number) {
    this.#scheduler = scheduler;
    this.#intervalMs = intervalMs;
  }
  start(events: HeartbeatEvents): void {
    this.stop();
    this.#beat(events);
  }
  /** A pong arrived. */
  pong(): void {
    this.#awaitingPong = false;
  }
  stop(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    this.#awaitingPong = false;
  }
  #beat(events: HeartbeatEvents): void {
    this.#cancel = this.#scheduler.set(this.#intervalMs, () => {
      this.#cancel = undefined;
      if (this.#awaitingPong) {
        events.missed();
        return;
      }
      this.#awaitingPong = true;
      if (events.ping()) this.#beat(events);
    });
  }
}

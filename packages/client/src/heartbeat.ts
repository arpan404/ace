import type { Scheduler } from "./types.ts";

interface HeartbeatEvents {
  /** Send a ping; false if it couldn't go out, which ends the beat. */
  ping(): boolean;
  /** A ping went a whole interval without the daemon sending anything. */
  missed(): void;
}

/**
 * Liveness of a ready socket: every interval it pings, and an interval after a ping in which
 * nothing at all arrived means the socket is dead even if it never closed. Any frame counts as
 * proof of life, not just the pong: the daemon sends its pong behind whatever it already queued,
 * so on a busy stream the pong can be late while the socket is plainly alive.
 */
export class Heartbeat {
  #scheduler: Scheduler;
  #intervalMs: number;
  #cancel: (() => void) | undefined;
  #awaiting = false;
  constructor(scheduler: Scheduler, intervalMs: number) {
    this.#scheduler = scheduler;
    this.#intervalMs = intervalMs;
  }
  start(events: HeartbeatEvents): void {
    this.stop();
    this.#beat(events);
  }
  /** A frame from the daemon arrived, the pong or any other. */
  heard(): void {
    this.#awaiting = false;
  }
  stop(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    this.#awaiting = false;
  }
  #beat(events: HeartbeatEvents): void {
    this.#cancel = this.#scheduler.set(this.#intervalMs, () => {
      this.#cancel = undefined;
      if (this.#awaiting) {
        events.missed();
        return;
      }
      this.#awaiting = true;
      if (events.ping()) this.#beat(events);
    });
  }
}

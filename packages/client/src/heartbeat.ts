import {
  initialHeartbeat,
  nextAt,
  stepHeartbeat,
  type HeartbeatInput,
  type HeartbeatState,
} from "./heartbeat-machine.ts";
import type { Scheduler } from "./types.ts";

interface HeartbeatEvents {
  /**
   * Send a ping; false if it couldn't go out. `answered` runs when the pong for this very ping
   * arrives: the daemon answers a socket's pings in order, so the nth pong answers the nth ping.
   */
  ping(answered?: () => void): boolean;
  /** The socket is dead: a beat heard nothing for an interval, or a probe went unanswered. */
  missed(): void;
}

/** A wake this soon after the last ping waits for the window's end to ping (ADR 0150). */
export const probeJoinMs = 300;

/**
 * The shell of `heartbeat-machine.ts` for one connection: it sends the pings the machine asks
 * for, tells it what came back, and runs one timer for the machine's next deadline. Time is
 * `now` when given; it never runs behind a timer that already fired, so a connection without a
 * clock still keeps its deadlines, measured by the scheduler.
 */
export class Heartbeat {
  #scheduler: Scheduler;
  #config: { intervalMs: number; joinMs: number };
  #state: HeartbeatState = initialHeartbeat();
  #events: HeartbeatEvents | undefined;
  #cancel: (() => void) | undefined;
  #clock: () => number;
  /** The time of the last timer that fired: time never reads earlier. */
  #floor = 0;
  constructor(scheduler: Scheduler, intervalMs: number, now?: () => number) {
    this.#scheduler = scheduler;
    this.#config = { intervalMs, joinMs: probeJoinMs };
    this.#clock = now ?? (() => 0);
  }
  start(events: HeartbeatEvents): void {
    this.#events = events;
    this.#feed({ type: "start", now: this.#now() });
  }
  /**
   * The app woke, or the network changed: check the socket, and drop it unless the pong for a
   * ping sent at or after now arrives within `withinMs` of that ping (sent within
   * `probeJoinMs`). A no-op unless a beat is running.
   */
  probe(withinMs: number): void {
    this.#feed({ type: "wake", now: this.#now(), withinMs });
  }
  /**
   * Whether another loop already pings this socket and drops it when a pong goes missing (the
   * path manager's, ADR 0114). While quiet there is no regular beat, so one socket never carries
   * two ping loops; `probe` still checks it at once.
   */
  quiet(on: boolean): void {
    this.#feed({ type: "quiet", on, now: this.#now() });
  }
  /** A frame from the daemon arrived, the pong or any other. */
  heard(): void {
    this.#feed({ type: "frame" });
  }
  stop(): void {
    this.#feed({ type: "stop" });
    this.#events = undefined;
  }
  #now(): number {
    return Math.max(this.#clock(), this.#floor);
  }
  #feed(input: HeartbeatInput): void {
    const { state, effects } = stepHeartbeat(this.#state, input, this.#config);
    this.#state = state;
    const events = this.#events;
    for (const effect of effects) {
      if (!events || this.#events !== events) break;
      if (effect.type === "missed") {
        this.#arm();
        events.missed();
        return;
      }
      const { seq } = effect;
      const sent = events.ping(() => {
        if (this.#events === events) this.#feed({ type: "pong", seq, now: this.#now() });
      });
      if (!sent) this.#feed({ type: "refused", seq, now: this.#now() });
    }
    this.#arm();
  }
  /** One timer, for the machine's next deadline. */
  #arm(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    const at = nextAt(this.#state);
    if (at === undefined) return;
    this.#cancel = this.#scheduler.set(Math.max(0, at - this.#now()), () => {
      this.#cancel = undefined;
      this.#floor = Math.max(this.#floor, at);
      this.#feed({ type: "timer", now: this.#now() });
    });
  }
}

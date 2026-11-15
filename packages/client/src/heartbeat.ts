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
 * for, tells it what came back, and runs one timer for the machine's next deadline. Its clock
 * is required and must be monotonic (`ClientOptions.monotonic`); time fed to the machine never
 * goes backwards even so: a source that jumps back carries on from where it was, as if no time
 * passed in the jump, rather than freezing until it catches up.
 */
export class Heartbeat {
  #scheduler: Scheduler;
  #config: { intervalMs: number; joinMs: number };
  #state: HeartbeatState = initialHeartbeat();
  #events: HeartbeatEvents | undefined;
  #cancel: (() => void) | undefined;
  #clock: () => number;
  /** Added to the clock so the time read never goes backwards, and the last time read. */
  #offset = 0;
  #last = -Infinity;
  /** The deadline the timer is armed for: an input that leaves it unchanged keeps the timer. */
  #armedAt: number | undefined;
  constructor(scheduler: Scheduler, intervalMs: number, clock: () => number) {
    this.#scheduler = scheduler;
    this.#config = { intervalMs, joinMs: probeJoinMs };
    this.#clock = clock;
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
    const raw = this.#clock() + this.#offset;
    if (raw < this.#last) this.#offset += this.#last - raw;
    this.#last = Math.max(raw, this.#last);
    return this.#last;
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
  /** One timer, for the machine's next deadline; kept as it is while that doesn't change. */
  #arm(): void {
    const at = nextAt(this.#state);
    if (at === this.#armedAt && (this.#cancel || at === undefined)) return;
    this.#cancel?.();
    this.#cancel = undefined;
    this.#armedAt = at;
    if (at === undefined) return;
    this.#cancel = this.#scheduler.set(Math.max(0, at - this.#now()), () => {
      this.#cancel = undefined;
      this.#armedAt = undefined;
      // A timer that fires early (the scheduler's clock runs ahead) is armed again for the rest.
      this.#feed({ type: "timer", now: this.#now() });
    });
  }
}

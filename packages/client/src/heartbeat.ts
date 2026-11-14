import type { Scheduler } from "./types.ts";

interface HeartbeatEvents {
  /**
   * Send a ping; false if it couldn't go out, which ends the beat. `answered` runs when the pong
   * for this very ping arrives: the daemon answers a socket's pings in order, so the nth pong
   * answers the nth ping.
   */
  ping(answered?: () => void): boolean;
  /** A ping went a whole interval without the daemon sending anything. */
  missed(): void;
}

/**
 * Liveness of a ready socket: every interval it pings, and an interval after a ping in which
 * nothing at all arrived means the socket is dead even if it never closed. Any frame counts as
 * proof of life, not just the pong: the daemon sends its pong behind whatever it already queued,
 * so on a busy stream the pong can be late while the socket is plainly alive.
 */
/** A wake this soon after the newest outstanding probe joins it instead of pinging again. */
export const probeJoinMs = 300;
/** At most this many probes wait at once; a wake beyond them is covered by the newest. */
export const maxProbes = 4;

export class Heartbeat {
  #scheduler: Scheduler;
  #intervalMs: number;
  #cancel: (() => void) | undefined;
  #awaiting = false;
  #events: HeartbeatEvents | undefined;
  /** Another loop pings this socket (the path manager's): no regular beat, probes only. */
  #quiet = false;
  /** Each probe still waiting out its own deadline: cancels its timer. */
  #probes = new Set<() => void>();
  /** When the newest outstanding probe pinged, on `now`. */
  #newestAt: number | undefined;
  #now: (() => number) | undefined;
  constructor(scheduler: Scheduler, intervalMs: number, now?: () => number) {
    this.#scheduler = scheduler;
    this.#intervalMs = intervalMs;
    this.#now = now;
  }
  start(events: HeartbeatEvents): void {
    this.stop();
    this.#events = events;
    this.#beat(events);
  }
  /**
   * Check now instead of at the next beat: ping at once and give the daemon `withinMs` to answer
   * that ping. Only the pong for the probe's own ping counts: a frame or a pong already on its
   * way before the probe (sent before the network changed under the socket) proves nothing
   * about the socket now. Silence ends the beat as a miss; once every probe is answered, the
   * regular beat resumes. A probe while others wait never moves their deadlines: each keeps its
   * own, so a socket dead at the first of many wakes is dropped `withinMs` after that one. A
   * wake within `probeJoinMs` of the newest outstanding probe joins it, and at most `maxProbes`
   * wait at once (a wake beyond them is covered by the newest), so a burst of wakes sends a few
   * pings, not one each. Either way a socket dead at a wake is dropped within one deadline plus
   * `probeJoinMs` of it. A no-op unless a beat is running.
   */
  probe(withinMs: number): void {
    const events = this.#events;
    if (!events) return;
    const at = this.#now?.();
    if (this.#probes.size) {
      // Without a clock every wake joins: the newest probe was sent no earlier than the first.
      const newest = this.#newestAt;
      const recent = at === undefined || newest === undefined || at - newest < probeJoinMs;
      if (recent || this.#probes.size >= maxProbes) return;
    }
    // The regular beat waits while any probe does.
    this.#cancel?.();
    this.#cancel = undefined;
    this.#awaiting = true;
    let answered = false;
    // A ping that can't go out (the socket ended, or owes too many pongs) is no probe: one
    // still waiting covers this wake, or the connection's own close does.
    if (!events.ping(() => (answered = true))) return;
    this.#newestAt = at;
    const cancel = this.#scheduler.set(withinMs, () => {
      this.#probes.delete(cancel);
      if (!answered) {
        events.missed();
        return;
      }
      if (this.#probes.size || this.#events !== events) return;
      this.#awaiting = false;
      this.#beat(events);
    });
    this.#probes.add(cancel);
  }
  /**
   * Whether another loop already pings this socket and drops it when a pong goes missing (the
   * path manager's, ADR 0114). While quiet there is no regular beat, so one socket never carries
   * two ping loops; `probe` still checks it at once.
   */
  quiet(on: boolean): void {
    if (on === this.#quiet) return;
    this.#quiet = on;
    const events = this.#events;
    // While probes wait, the beat stays off; the last one answered starts it again.
    if (!events || this.#awaiting || this.#probes.size) return;
    this.#cancel?.();
    this.#cancel = undefined;
    this.#beat(events);
  }
  /** A frame from the daemon arrived, the pong or any other. */
  heard(): void {
    this.#awaiting = false;
  }
  stop(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    for (const cancel of this.#probes) cancel();
    this.#probes.clear();
    this.#awaiting = false;
    this.#events = undefined;
  }
  #beat(events: HeartbeatEvents): void {
    if (this.#quiet) return;
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

import type { HeartbeatClock } from "@ace/diagnostics/stall";
import type { FreezeSignal, Thaw } from "../daemon/watchdog.ts";

/** How often the main thread beats: often enough for a 2 s freeze threshold. */
export const mainBeatMs = 500;

export interface MainBeat extends FreezeSignal {
  /**
   * A clock for the stall watchdog's heartbeat: everything given to it runs on the one beat,
   * whatever period it asks for.
   */
  clock: HeartbeatClock;
  /**
   * The OS says the computer woke (Electron's powerMonitor `resume`): the gap around now is
   * sleep, not the main thread freezing, whether the beat has already seen it or is about to.
   */
  resumed(): void;
  stop(): void;
}

/**
 * The main process's one repeating timer for noticing its own freezes. The stall watchdog's
 * heartbeat runs on it, and a daemon health check reads from it whether the app froze while
 * the check was out, so neither keeps a timer of its own. A beat that comes more than
 * `toleranceMs` late marks a thaw; one around a resume the OS reported marks it as sleep.
 */
export function startMainBeat(options: {
  clock: HeartbeatClock;
  now(): number;
  beatMs?: number;
  toleranceMs?: number;
}): MainBeat {
  const beatMs = options.beatMs ?? mainBeatMs;
  const tolerance = options.toleranceMs ?? 2_000;
  const listeners = new Set<() => void>();
  let beatAt = options.now();
  let thaw: Thaw | undefined;
  /** A resume was said and the beat has not yet run since. */
  let woke = false;
  const stop = options.clock.every(beatMs, () => {
    const now = options.now();
    const gap = now - beatAt - beatMs;
    if (gap > tolerance) thaw = { at: now, frozenMs: Math.round(gap), slept: woke };
    woke = false;
    beatAt = now;
    for (const listener of listeners) listener();
  });
  return {
    clock: {
      every(_milliseconds, tick) {
        listeners.add(tick);
        return () => listeners.delete(tick);
      },
    },
    lastThaw: () => thaw,
    resumed() {
      const now = options.now();
      // The beat already came back from the gap: that thaw was the sleep. Otherwise the gap
      // so far is the sleep, and the beat that ends it says so too.
      if (thaw && thaw.at === beatAt) thaw = { ...thaw, slept: true };
      else {
        const gap = now - beatAt - beatMs;
        if (gap > tolerance) thaw = { at: now, frozenMs: Math.round(gap), slept: true };
        woke = true;
      }
    },
    stop,
  };
}

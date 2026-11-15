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
  stop(): void;
}

/**
 * The main process's one repeating timer for noticing its own freezes. The stall watchdog's
 * heartbeat runs on it, and a daemon health check reads from it whether the app froze while
 * the check was out, so neither keeps a timer of its own. A beat that comes more than
 * `toleranceMs` late marks a thaw.
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
  const stop = options.clock.every(beatMs, () => {
    const now = options.now();
    const gap = now - beatAt - beatMs;
    if (gap > tolerance) thaw = { at: now, frozenMs: Math.round(gap) };
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
    stop,
  };
}

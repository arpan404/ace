import type { LocalDaemon } from "./probe.ts";

export interface DrainPorts {
  /**
   * Add or remove the update's own hold on admission; resolves with the work still running.
   * It never touches the person's pause, which only they end.
   */
  setUpdateHold(daemon: LocalDaemon, on: boolean): Promise<number>;
  blockers(daemon: LocalDaemon): Promise<number>;
  timers: { set(delayMs: number, callback: () => void): () => void };
  now(): number;
}

export interface DrainRequest {
  deadlineMs: number;
  pollMs: number;
  /** The person had paused new work before the drain; the tray keeps saying so afterwards. */
  wasPaused: boolean;
  /** False once the daemon was replaced or the app moved on; the drain then gives up. */
  current(): boolean;
  /** Admission changed: the status's `paused` follows it. */
  paused(on: boolean): void;
  /** The work still running, each time it is counted. */
  waiting?(count: number): void;
}

/**
 * Before an app update replaces the daemon: hold admission and wait for running work to finish
 * naturally. True once nothing is running, with the update's hold kept for the install. On every
 * other exit (the deadline, a failed request, or the daemon or app moving on) the hold is let go
 * while it is still the same daemon; the daemon's own lease (`update-hold.ts`) covers the rest.
 * Each poll renews that lease. The person's pause, if any, stays.
 */
export async function drainForUpdate(
  ports: DrainPorts,
  daemon: LocalDaemon,
  request: DrainRequest,
): Promise<boolean> {
  let drained = false;
  try {
    let blockers = await ports.setUpdateHold(daemon, true);
    if (!request.current()) return false;
    request.paused(true);
    request.waiting?.(blockers);
    const until = ports.now() + request.deadlineMs;
    while (blockers > 0 && ports.now() < until) {
      await new Promise<void>((resolve) => ports.timers.set(request.pollMs, resolve));
      if (!request.current()) return false;
      blockers = await ports.setUpdateHold(daemon, true);
      request.waiting?.(blockers);
    }
    drained = blockers === 0;
    return drained && request.current();
  } finally {
    if (!drained && request.current()) {
      await ports.setUpdateHold(daemon, false).catch(() => {});
      request.paused(request.wasPaused);
    }
  }
}

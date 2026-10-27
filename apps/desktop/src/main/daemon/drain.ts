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
 * Before an app update replaces the daemon: close admission and wait for running work to
 * finish naturally. True once nothing is running; false (with the update's hold removed) if work
 * remains at the deadline or the daemon stopped being current. The person's pause, if any, stays.
 */
export async function drainForUpdate(
  ports: DrainPorts,
  daemon: LocalDaemon,
  request: DrainRequest,
): Promise<boolean> {
  let blockers = await ports.setUpdateHold(daemon, true);
  if (!request.current()) return false;
  request.paused(true);
  request.waiting?.(blockers);
  const until = ports.now() + request.deadlineMs;
  while (blockers > 0 && ports.now() < until) {
    await new Promise<void>((resolve) => ports.timers.set(request.pollMs, resolve));
    if (!request.current()) return false;
    blockers = await ports.blockers(daemon);
    request.waiting?.(blockers);
  }
  if (!request.current()) return false;
  if (blockers > 0) await ports.setUpdateHold(daemon, false);
  if (request.current()) request.paused(blockers === 0 || request.wasPaused);
  return blockers === 0;
}

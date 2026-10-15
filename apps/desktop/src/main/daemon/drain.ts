import type { LocalDaemon } from "./probe.ts";

export interface DrainPorts {
  /** Close or reopen admission; resolves with the work still running. */
  setMaintenance(daemon: LocalDaemon, on: boolean): Promise<number>;
  blockers(daemon: LocalDaemon): Promise<number>;
  timers: { set(delayMs: number, callback: () => void): () => void };
  now(): number;
}

export interface DrainRequest {
  deadlineMs: number;
  pollMs: number;
  /** Paused before the drain: admission stays closed whatever the outcome. */
  wasPaused: boolean;
  /** False once the daemon was replaced or the app moved on; the drain then gives up. */
  current(): boolean;
  /** Admission changed: the status's `paused` follows it. */
  paused(on: boolean): void;
}

/**
 * Before an app update replaces the daemon: close admission and wait for running work to
 * finish naturally. True once nothing is running; false (with admission reopened, unless it
 * was paused before) if work remains at the deadline or the daemon stopped being current.
 */
export async function drainForUpdate(
  ports: DrainPorts,
  daemon: LocalDaemon,
  request: DrainRequest,
): Promise<boolean> {
  let blockers = await ports.setMaintenance(daemon, true);
  if (!request.current()) return false;
  request.paused(true);
  const until = ports.now() + request.deadlineMs;
  while (blockers > 0 && ports.now() < until) {
    await new Promise<void>((resolve) => ports.timers.set(request.pollMs, resolve));
    if (!request.current()) return false;
    blockers = await ports.blockers(daemon);
  }
  if (!request.current()) return false;
  if (blockers > 0 && !request.wasPaused) await ports.setMaintenance(daemon, false);
  if (request.current()) request.paused(blockers === 0 || request.wasPaused);
  return blockers === 0;
}

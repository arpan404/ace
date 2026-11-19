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

export interface ReplacementDrain {
  deadlineMs: number;
  pollMs: number;
  /** False once the app moved on (a quit, a repair): the drain ends and lets go of its hold. */
  current(): boolean;
  /** Whether the old daemon answered the last hold request; called when that changes. */
  answering(on: boolean): void;
}

/**
 * Before an old daemon of the app's own is replaced at launch (ADR 0186): hold its admission and
 * wait for running work to finish, up to the deadline. A request that fails (a daemon busy with a
 * turn answers late) is asked again at the next poll, never taken as the end of the wait, so
 * working agents keep the whole allowance. `drained` once nothing runs; `deadline` once the time
 * is up, whether or not it ever answered; `abandoned` when the app moved on, after letting go of
 * the hold, so a daemon left running takes new work again.
 */
export async function drainForReplacement(
  ports: DrainPorts,
  daemon: LocalDaemon,
  request: ReplacementDrain,
): Promise<"drained" | "deadline" | "abandoned"> {
  const until = ports.now() + request.deadlineMs;
  let answering = true;
  for (;;) {
    let blockers: number | undefined;
    try {
      blockers = await ports.setUpdateHold(daemon, true);
    } catch {
      blockers = undefined;
    }
    if (!request.current()) {
      await ports.setUpdateHold(daemon, false).catch(() => {});
      return "abandoned";
    }
    if ((blockers !== undefined) !== answering) {
      answering = blockers !== undefined;
      request.answering(answering);
    }
    if (blockers === 0) return "drained";
    if (ports.now() >= until) return "deadline";
    await new Promise<void>((resolve) => ports.timers.set(request.pollMs, resolve));
    if (!request.current()) {
      await ports.setUpdateHold(daemon, false).catch(() => {});
      return "abandoned";
    }
  }
}

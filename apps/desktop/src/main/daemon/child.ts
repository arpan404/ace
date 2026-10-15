/** A daemon child process this app started. */
export interface DaemonProcess {
  kill(signal: NodeJS.Signals): void;
  /**
   * Called once when the process is gone. `error` is set when it never started (ENOENT,
   * EACCES): Node then emits `error` but no `exit`.
   */
  onExit(
    listener: (code: number | null, signal: NodeJS.Signals | null, error?: string) => void,
  ): void;
}

/** Why this app signalled its daemon: a repair or quit, a hung daemon, or one that never started. */
export type StopReason = "requested" | "unresponsive" | "not-ready";

/** A child this app spawned. `intentional` is set before any stop this app asks for. */
export interface Child {
  process: DaemonProcess;
  exited: Promise<void>;
  done: boolean;
  intentional: boolean;
  /** Set when this app signalled it, so its exit names the reason. */
  stopReason?: StopReason;
}

export interface StopPorts {
  /** Between SIGTERM and SIGKILL, and again for the exit report after SIGKILL. */
  graceMs: number;
  timers: { set(delayMs: number, callback: () => void): () => void };
  log(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void;
}

/** Track a spawned process until it is gone. `onExit` runs once, after `exited` resolves. */
export function trackChild(
  handle: DaemonProcess,
  onExit: (child: Child, code: number | null, signal: string | null, error?: string) => void,
): Child {
  const exit = Promise.withResolvers<void>();
  const child: Child = { process: handle, exited: exit.promise, done: false, intentional: false };
  handle.onExit((code, signal, error) => {
    if (child.done) return;
    child.done = true;
    exit.resolve();
    onExit(child, code, signal, error);
  });
  return child;
}

/**
 * Stop a child without marking the stop intentional, so its exit takes the crash path and
 * restarts: SIGTERM, then SIGKILL only if it is still running after the grace period.
 */
export function terminate(child: Child, reason: StopReason, ports: StopPorts): void {
  const { graceMs } = ports;
  child.stopReason = reason;
  ports.log("warn", "Sending SIGTERM to the daemon", { reason, graceMs });
  child.process.kill("SIGTERM");
  const cancel = ports.timers.set(graceMs, () => {
    // A repair or quit since then runs its own escalation.
    if (child.done || child.intentional) return;
    ports.log("error", "The daemon did not exit after SIGTERM; sending SIGKILL", {
      reason,
      graceMs,
    });
    child.process.kill("SIGKILL");
  });
  void child.exited.then(cancel);
}

/** Resolves after `delayMs`, or never if cancelled; `cancel` clears the timer. */
function delay(ports: StopPorts, delayMs: number, onElapsed: () => void) {
  let cancel: (() => void) | undefined;
  const elapsed = new Promise<void>((resolve) => {
    cancel = ports.timers.set(delayMs, () => {
      onElapsed();
      resolve();
    });
  });
  return { elapsed, cancel: () => cancel?.() };
}

/**
 * Stop a child on purpose: SIGTERM, then SIGKILL after the grace period. A process that never
 * reports its exit after SIGKILL is marked done anyway, so it cannot hold up repair or quit
 * forever. Resolves once the child is gone or given up on.
 */
export async function stopChild(child: Child, ports: StopPorts): Promise<void> {
  if (child.done) return;
  child.intentional = true;
  child.stopReason = "requested";
  const { graceMs } = ports;
  ports.log("info", "Stopping the daemon", { graceMs });
  child.process.kill("SIGTERM");
  const forced = delay(ports, graceMs, () => {
    ports.log("warn", "The daemon did not exit after SIGTERM; sending SIGKILL", {
      reason: "requested",
      graceMs,
    });
    child.process.kill("SIGKILL");
  });
  await Promise.race([child.exited, forced.elapsed]);
  forced.cancel();
  if (child.done) return;
  let gaveUp = false;
  const bound = delay(ports, graceMs, () => {
    gaveUp = true;
  });
  await Promise.race([child.exited, bound.elapsed]);
  bound.cancel();
  if (gaveUp && !child.done) {
    ports.log("error", "The daemon did not report its exit after SIGKILL");
    child.done = true;
  }
}

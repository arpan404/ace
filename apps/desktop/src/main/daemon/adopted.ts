import type { DaemonProcess } from "./child.ts";

export interface AdoptedPorts {
  /** Whether the process is still there (`process.kill(pid, 0)`). */
  alive(pid: number): boolean;
  /** Whether the home's lock still names `pid`: a signal is sent only while it does. */
  owns(pid: number): Promise<boolean>;
  signal(pid: number, signal: NodeJS.Signals): void;
  /**
   * Windows: asks the daemon to shut down (`POST /v1/stop`), since a signal there ends the
   * process without its own shutdown. False when it was not accepted. Unset elsewhere.
   */
  requestStop?: ((pid: number) => Promise<boolean>) | undefined;
  /** How often to look whether the process has gone: it is not this app's child any more. */
  pollMs: number;
  timers: { set(delayMs: number, callback: () => void): () => void };
}

/**
 * A daemon an earlier launch of this app started and left running (ADR 0186), supervised as
 * the app's own: it stops on the same signals, and its exit is noticed by looking for the pid,
 * since it is no longer this process's child. No exit code reaches a non-parent, so its exit
 * reports neither code nor signal.
 */
export function adoptedProcess(pid: number, ports: AdoptedPorts): DaemonProcess {
  type Exit = [code: number | null, signal: NodeJS.Signals | null];
  let result: Exit | undefined;
  const listeners = new Set<(...exit: Exit) => void>();
  let cancel: (() => void) | undefined;
  const finish = () => {
    if (result) return;
    result = [null, null];
    cancel?.();
    for (const listener of listeners) listener(...result);
    listeners.clear();
  };
  const watch = () => {
    cancel = ports.timers.set(ports.pollMs, () => {
      if (ports.alive(pid)) watch();
      else finish();
    });
  };
  if (ports.alive(pid)) watch();
  else finish();
  const send = (signal: NodeJS.Signals) => {
    try {
      ports.signal(pid, signal);
    } catch {
      // Gone between the check and the signal: the next look reports the exit.
    }
  };
  return {
    pid,
    kill(signal) {
      if (result) return;
      // A pid can be reused once its daemon is gone: signal it only while it holds the lock.
      void ports
        .owns(pid)
        .then(async (owned) => {
          if (!owned || result) return;
          if (signal === "SIGTERM" && ports.requestStop && (await ports.requestStop(pid))) return;
          send(signal);
        })
        .catch(() => {});
    },
    onExit(listener) {
      if (result) listener(...result);
      else listeners.add(listener);
    },
  };
}

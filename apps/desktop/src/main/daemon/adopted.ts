import type { DaemonProcess } from "./child.ts";

export interface AdoptedPorts {
  /**
   * Whether the adopted run is still there: its pid exists and the home's lock still names that
   * pid and that run's id. A pid reused by another daemon (the CLI's, after this app slept
   * through the adopted one's exit) writes its own run id, so it is never mistaken for it.
   */
  sameRun(): Promise<boolean>;
  signal(pid: number, signal: NodeJS.Signals): void;
  /**
   * Windows: asks the daemon to shut down (`POST /v1/stop`), since a signal there ends the
   * process without its own shutdown. False when it was not accepted. Unset elsewhere.
   */
  requestStop?: ((pid: number) => Promise<boolean>) | undefined;
  /** How often to look whether the run has gone: it is not this app's child any more. */
  pollMs: number;
  timers: { set(delayMs: number, callback: () => void): () => void };
}

/**
 * A daemon an earlier launch of this app started and left running (ADR 0186), supervised as
 * the app's own: it stops on the same signals, and its exit is noticed by looking for its run,
 * since it is no longer this process's child. A run whose lock changed hands has exited, as far
 * as this app is concerned, and is never signalled. No exit code reaches a non-parent, so its
 * exit reports neither code nor signal.
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
  /** Looks once; the run gone (or no longer telling) ends it. */
  const look = async () => {
    if (result) return false;
    const same = await ports.sameRun().catch(() => false);
    if (!same) finish();
    return same && !result;
  };
  const watch = () => {
    cancel = ports.timers.set(ports.pollMs, () => {
      void look().then((same) => {
        if (same) watch();
      });
    });
  };
  watch();
  const send = (signal: NodeJS.Signals) => {
    try {
      ports.signal(pid, signal);
    } catch {
      // Gone between the look and the signal: the next look reports the exit.
    }
  };
  return {
    pid,
    kill(signal) {
      // A signal goes out only right after a look that finds the same run still there: anything
      // awaited in between (Windows' stop request, up to seconds) is followed by a fresh look.
      const stop = async () => {
        if (!(await look())) return;
        if (signal === "SIGTERM" && ports.requestStop) {
          if (await ports.requestStop(pid)) return;
          if (!(await look())) return;
        }
        send(signal);
      };
      void stop().catch(() => {});
    },
    onExit(listener) {
      if (result) listener(...result);
      else listeners.add(listener);
    },
  };
}

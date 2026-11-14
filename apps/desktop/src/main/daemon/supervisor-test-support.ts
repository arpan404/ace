import type { DaemonStatus } from "../../shared/contract.ts";
import { startMainBeat } from "../diagnostics/main-beat.ts";
import type { LocalDaemon } from "./probe.ts";
import type { DaemonProcess, DaemonSupervisor, SupervisorPorts } from "./supervisor.ts";

export const local: LocalDaemon = {
  origin: "http://127.0.0.1:4242",
  url: "ws://127.0.0.1:4242/",
  token: "a".repeat(64),
};

/**
 * A fake machine: a clock with timers, a process table and a daemon that may answer. With
 * `sharedBeat`, health checks read the app's one main-thread beat instead of beating on their own.
 */
export function machine(options: { sharedBeat?: boolean } = {}) {
  let now = 0;
  /** While the app is frozen, answers the daemon sent wait unread, as in a socket. */
  let frozen = false;
  const unread: (() => void)[] = [];
  const timers: { at: number; callback: () => void; cancelled: boolean }[] = [];
  const children: FakeChild[] = [];
  const signals: string[] = [];
  const log: { level: string; message: string; data?: Record<string, unknown> }[] = [];
  const state = {
    answering: false,
    healthy: true,
    external: false,
    blockers: 0,
    /** The person's pause (the tray's hold). */
    maintenance: false,
    /** An update's own hold, apart from the person's pause. */
    updateHold: false,
    /** How many of the next update-hold requests land but lose their reply. */
    holdReplyFails: 0,
    admissionAvailable: true,
    /** Whether the status answer carries admission (older daemons leave it out). */
    admissionInStatus: true,
    /** How long the daemon takes to answer a health check (a busy event loop). */
    healthDelayMs: 0,
    /** A hung daemon: health requests get no answer and fail at their own timeout. */
    hung: false,
    /** Ignores SIGTERM, as a hung daemon does. */
    ignoresSigterm: false,
    /** Exits this long after SIGTERM, as a daemon finishing its shutdown does. */
    sigtermExitMs: 0,
  };
  const later = (delayMs: number, callback: () => void) => ports.timers.set(delayMs, callback);
  const admission = () => {
    const holds = [...(state.maintenance ? ["user"] : []), ...(state.updateHold ? ["update"] : [])];
    return { draining: holds.length > 0, holds };
  };
  class FakeChild implements DaemonProcess {
    exit:
      | ((code: number | null, signal: NodeJS.Signals | null, error?: string) => void)
      | undefined;
    alive = true;
    /** A process that never started: signals do nothing and no exit ever follows. */
    unstarted = false;
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      if (this.unstarted) return;
      if (signal === "SIGKILL") this.die(null, signal);
      else if (!state.healthy || state.ignoresSigterm) return;
      else if (state.sigtermExitMs) later(state.sigtermExitMs, () => this.die(0));
      else this.die(null, signal);
    }
    onExit(listener: (code: number | null, signal: NodeJS.Signals | null, error?: string) => void) {
      this.exit = listener;
    }
    /** Node's `error` for a binary that could not be executed (ENOENT, EACCES). */
    failToStart(message: string) {
      this.unstarted = true;
      this.alive = false;
      this.exit?.(null, null, message);
    }
    die(code: number | null, signal: NodeJS.Signals | null = null) {
      if (!this.alive) return;
      this.alive = false;
      state.answering = state.external;
      this.exit?.(code, signal);
    }
  }
  const ports: SupervisorPorts = {
    spawn() {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    find: async () => (state.answering ? local : undefined),
    health: (_daemon, timeoutMs) =>
      new Promise((resolve) => {
        // The request's own deadline, as `AbortSignal.timeout` gives it.
        later(timeoutMs, () => resolve({ healthy: false }));
        if (state.hung) return;
        const answer = () =>
          resolve(
            !(state.answering && state.healthy)
              ? { healthy: false }
              : state.admissionInStatus
                ? { healthy: true, admission: admission() }
                : { healthy: true },
          );
        const arrive = () => (frozen ? unread.push(answer) : answer());
        if (state.healthDelayMs) later(state.healthDelayMs, arrive);
        else answer();
      }),
    setMaintenance: async (_daemon, on) => {
      state.maintenance = on;
      return state.blockers;
    },
    setUpdateHold: async (_daemon, on) => {
      state.updateHold = on;
      // The request landed, but its reply was lost (a timeout on a busy daemon).
      if (on && state.holdReplyFails > 0) {
        state.holdReplyFails--;
        throw new Error("The request timed out");
      }
      return state.blockers;
    },
    blockers: async () => state.blockers,
    maintenance: async () => {
      if (!state.admissionAvailable) throw new Error("Admission request timed out");
      return admission();
    },
    timers: {
      set(delayMs, callback) {
        const timer = { at: now + delayMs, callback, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
    now: () => now,
    log: (level, message, data) => log.push({ level, message, ...(data ? { data } : {}) }),
  };
  if (options.sharedBeat)
    ports.freezes = startMainBeat({
      now: () => now,
      clock: {
        every(milliseconds, tick) {
          let cancel = () => {};
          const beat = () => {
            tick();
            cancel = ports.timers.set(milliseconds, beat);
          };
          cancel = ports.timers.set(milliseconds, beat);
          return () => cancel();
        },
      },
    });
  async function advance(ms: number) {
    const until = now + ms;
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve));
      const next = timers
        .filter((timer) => !timer.cancelled && timer.at <= until)
        .toSorted((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.cancelled = true;
      now = next.at;
      next.callback();
    }
    now = until;
    await new Promise((resolve) => setImmediate(resolve));
  }
  /**
   * The app's main thread blocks for `ms`: nothing runs, then every overdue timer fires at
   * once, and only after them does the I/O that arrived meanwhile (as Node orders a turn).
   */
  async function freeze(ms: number) {
    frozen = true;
    now += ms;
    for (;;) {
      const next = timers
        .filter((timer) => !timer.cancelled && timer.at <= now)
        .toSorted((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.cancelled = true;
      next.callback();
      await Promise.resolve();
    }
    frozen = false;
    for (const answer of unread.splice(0)) answer();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { ports, state, children, signals, log, advance, freeze };
}

export function track(supervisor: DaemonSupervisor): DaemonStatus[] {
  const seen: DaemonStatus[] = [];
  supervisor.onStatus((status) => seen.push(status));
  return seen;
}

import type { DaemonStatus } from "../../shared/contract.ts";
import type { LocalDaemon } from "./probe.ts";
import type { DaemonProcess, DaemonSupervisor, SupervisorPorts } from "./supervisor.ts";

export const local: LocalDaemon = {
  origin: "http://127.0.0.1:4242",
  url: "ws://127.0.0.1:4242/",
  token: "a".repeat(64),
};

/** A fake machine: a clock with timers, a process table and a daemon that may answer. */
export function machine() {
  let now = 0;
  const timers: { at: number; callback: () => void; cancelled: boolean }[] = [];
  const children: FakeChild[] = [];
  const signals: string[] = [];
  const log: { level: string; message: string; data?: Record<string, unknown> }[] = [];
  const state = {
    answering: false,
    healthy: true,
    external: false,
    blockers: 0,
    maintenance: false,
    admissionAvailable: true,
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
    healthy: (_daemon, timeoutMs) =>
      new Promise((resolve) => {
        if (state.hung) later(timeoutMs, () => resolve(false));
        else if (state.healthDelayMs)
          later(state.healthDelayMs, () => resolve(state.answering && state.healthy));
        else resolve(state.answering && state.healthy);
      }),
    setMaintenance: async (_daemon, on) => {
      state.maintenance = on;
      return state.blockers;
    },
    blockers: async () => state.blockers,
    maintenance: async () => {
      if (!state.admissionAvailable) throw new Error("Admission request timed out");
      return { draining: state.maintenance };
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
  return { ports, state, children, signals, log, advance };
}

export function track(supervisor: DaemonSupervisor): DaemonStatus[] {
  const seen: DaemonStatus[] = [];
  supervisor.onStatus((status) => seen.push(status));
  return seen;
}

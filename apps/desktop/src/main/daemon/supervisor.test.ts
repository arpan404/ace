import { describe, expect, it } from "vitest";
import type { DaemonStatus } from "../../shared/contract.ts";
import type { LocalDaemon } from "./probe.ts";
import { DaemonSupervisor, type DaemonProcess, type SupervisorPorts } from "./supervisor.ts";

const local: LocalDaemon = {
  origin: "http://127.0.0.1:4242",
  url: "ws://127.0.0.1:4242/",
  token: "a".repeat(64),
};

/** A fake machine: a clock with timers, a process table and a daemon that may answer. */
function machine() {
  let now = 0;
  const timers: { at: number; callback: () => void; cancelled: boolean }[] = [];
  const children: FakeChild[] = [];
  const signals: string[] = [];
  const log: string[] = [];
  const state = { answering: false, healthy: true, external: false, blockers: 0, maintenance: false };
  class FakeChild implements DaemonProcess {
    exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    alive = true;
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      if (signal === "SIGKILL" || state.healthy) this.die(null, signal);
    }
    onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void) {
      this.exit = listener;
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
    healthy: async () => state.answering && state.healthy,
    setMaintenance: async (_daemon, on) => {
      state.maintenance = on;
      return state.blockers;
    },
    blockers: async () => state.blockers,
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
    log: (level, message) => log.push(`${level}: ${message}`),
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

function track(supervisor: DaemonSupervisor): DaemonStatus[] {
  const seen: DaemonStatus[] = [];
  supervisor.onStatus((status) => seen.push(status));
  return seen;
}

describe("daemon supervisor", () => {
  it("reuses a daemon that is already running instead of starting another", async () => {
    const m = machine();
    m.state.answering = true;
    m.state.external = true;
    const supervisor = new DaemonSupervisor(m.ports);
    await supervisor.start();
    expect(m.children).toHaveLength(0);
    expect(supervisor.current()).toMatchObject({ state: "running", source: "external" });
    expect(await supervisor.ready()).toEqual(local);
  });

  it("never stops a daemon it did not start", async () => {
    const m = machine();
    m.state.answering = true;
    m.state.external = true;
    const supervisor = new DaemonSupervisor(m.ports);
    await supervisor.start();
    await supervisor.stop();
    expect(m.signals).toEqual([]);
    expect(supervisor.current().state).toBe("stopped");
  });

  it("starts the bundled daemon when none answers and reports it once it is ready", async () => {
    const m = machine();
    const supervisor = new DaemonSupervisor(m.ports);
    await supervisor.start();
    expect(m.children).toHaveLength(1);
    expect(supervisor.current().state).toBe("starting");
    m.state.answering = true;
    await m.advance(300);
    expect(supervisor.current()).toMatchObject({ state: "running", source: "app" });
  });

  it("waits for a development daemon it may not start, and follows its restarts", async () => {
    const m = machine();
    m.ports.spawn = undefined;
    const supervisor = new DaemonSupervisor(m.ports, { healthIntervalMs: 1_000, healthFailures: 1 });
    void supervisor.start();
    await m.advance(60_000);
    expect(supervisor.current().state).toBe("starting");
    m.state.answering = true;
    await m.advance(300);
    expect(supervisor.current()).toMatchObject({ state: "running", source: "external" });

    m.state.answering = false;
    await m.advance(1_000);
    expect(supervisor.current().state).not.toBe("running");
    m.state.answering = true;
    await m.advance(300);
    expect(supervisor.current().state).toBe("running");
    expect(m.children).toHaveLength(0);
  });

  it("uses an installed login service rather than spawning a duplicate", async () => {
    const m = machine();
    let started = false;
    m.ports.service = {
      active: async () => started,
      start: async () => {
        started = true;
        m.state.answering = true;
        m.state.external = true;
      },
    };
    const supervisor = new DaemonSupervisor(m.ports);
    await supervisor.start();
    expect(m.children).toHaveLength(0);
    expect(supervisor.current()).toMatchObject({ state: "running", source: "service" });
  });

  it("restarts a crashed daemon with growing delays", async () => {
    const m = machine();
    const supervisor = new DaemonSupervisor(m.ports);
    const seen = track(supervisor);
    await supervisor.start();
    m.state.answering = true;
    await m.advance(300);

    m.children[0]?.die(1);
    expect(supervisor.current()).toMatchObject({ state: "restarting", restarts: 1 });
    await m.advance(499);
    expect(m.children).toHaveLength(1);
    await m.advance(1);
    expect(m.children).toHaveLength(2);

    m.state.answering = true;
    await m.advance(300);
    m.children[1]?.die(1);
    await m.advance(999);
    expect(m.children).toHaveLength(2);
    await m.advance(1);
    expect(m.children).toHaveLength(3);
    expect(seen.some((status) => status.state === "running")).toBe(true);
  });

  it("gives up after repeated crashes and tries again when asked to repair", async () => {
    const m = machine();
    const supervisor = new DaemonSupervisor(m.ports, { maxRestarts: 2 });
    await supervisor.start();
    for (let crash = 0; crash < 3; crash++) {
      m.children.at(-1)?.die(1);
      await m.advance(10_000);
    }
    expect(supervisor.current().state).toBe("failed");
    const spawned = m.children.length;
    await m.advance(120_000);
    expect(m.children).toHaveLength(spawned);

    await supervisor.restart();
    expect(m.children).toHaveLength(spawned + 1);
  });

  it("forgets earlier crashes once the daemon has run stably", async () => {
    const m = machine();
    const supervisor = new DaemonSupervisor(m.ports, { maxRestarts: 1, stableMs: 1_000 });
    await supervisor.start();
    m.state.answering = true;
    await m.advance(300);
    m.children[0]?.die(1);
    await m.advance(500);
    m.state.answering = true;
    await m.advance(5_000);
    m.children[1]?.die(1);
    expect(supervisor.current().state).toBe("restarting");
  });

  it("kills the daemon it started when it stops answering health checks", async () => {
    const m = machine();
    const supervisor = new DaemonSupervisor(m.ports, { healthIntervalMs: 1_000, healthFailures: 2 });
    await supervisor.start();
    m.state.answering = true;
    await m.advance(300);
    m.state.healthy = false;
    await m.advance(2_000);
    expect(m.signals).toContain("SIGKILL");
    expect(supervisor.current().state).toBe("restarting");
  });

  it("stops its own daemon with SIGTERM, then SIGKILL after the grace period", async () => {
    const m = machine();
    const supervisor = new DaemonSupervisor(m.ports, { stopGraceMs: 1_000 });
    await supervisor.start();
    m.state.answering = true;
    await m.advance(300);
    m.state.healthy = false; // ignores SIGTERM
    const stopped = supervisor.stop();
    await m.advance(1_000);
    await stopped;
    expect(m.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(supervisor.current().state).toBe("stopped");
  });

  it("drains before an update and reopens admission when work is still running", async () => {
    const m = machine();
    const supervisor = new DaemonSupervisor(m.ports);
    await supervisor.start();
    m.state.answering = true;
    await m.advance(300);

    m.state.blockers = 2;
    const draining = supervisor.drain(5_000);
    await m.advance(6_000);
    expect(await draining).toBe(false);
    expect(m.state.maintenance).toBe(false);

    m.state.blockers = 0;
    const drained = supervisor.drain(5_000);
    await m.advance(1_000);
    expect(await drained).toBe(true);
    expect(m.state.maintenance).toBe(true);
  });
});

import type { DaemonStatus } from "../../shared/contract.ts";
import type { LocalDaemon } from "./probe.ts";

/** A daemon child process this app started. */
export interface DaemonProcess {
  kill(signal: NodeJS.Signals): void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface SupervisorPorts {
  /**
   * Start the bundled daemon. Without it (development, attached to `bun run daemon`) the
   * supervisor only waits for a daemon.
   */
  spawn?: (() => DaemonProcess) | undefined;
  /** A healthy daemon already serving this ACE_HOME, if any. */
  find(): Promise<LocalDaemon | undefined>;
  healthy(daemon: LocalDaemon): Promise<boolean>;
  /** The login service from `ace service install`, when one is installed. */
  service?: { active(): Promise<boolean>; start(): Promise<void> } | undefined;
  setMaintenance(daemon: LocalDaemon, on: boolean): Promise<number>;
  blockers(daemon: LocalDaemon): Promise<number>;
  timers: { set(delayMs: number, callback: () => void): () => void };
  now(): number;
  log(level: "info" | "warn" | "error", message: string): void;
}

export interface SupervisorOptions {
  healthIntervalMs?: number;
  /** Consecutive failed health checks before the daemon is treated as gone. */
  healthFailures?: number;
  readyTimeoutMs?: number;
  stopGraceMs?: number;
  /** Crashes in a row (without a stable run in between) before giving up. */
  maxRestarts?: number;
  /** Running this long resets the crash count. */
  stableMs?: number;
}

/** Exponential restart delay: 0.5 s, 1 s, 2 s … capped at 30 s. */
export function restartDelay(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** Math.max(0, attempt));
}

type Source = DaemonStatus["source"];

/** A child this app spawned. `intentional` is set before any stop this app asks for. */
interface Child {
  process: DaemonProcess;
  exited: Promise<void>;
  done: boolean;
  intentional: boolean;
}

/**
 * Keeps one daemon available for this ACE_HOME. It reuses a running daemon (another app
 * window, the CLI or the login service) and only spawns its own when none answers. It
 * restarts only the daemon it started, with backoff, and never stops one it did not start.
 *
 * Lifecycle requests (`start`, `restart`, `stop` and crash restarts) are transitions run one
 * at a time in order. Each bumps a generation, so slower work from an earlier transition
 * (a readiness wait, a health check) sees it is stale and does nothing. A child this app
 * stops on purpose is marked first, so its exit is never mistaken for a crash, and every
 * spawned child is tracked until it has exited, so a later `stop` always reaches it.
 */
export class DaemonSupervisor {
  private ports: SupervisorPorts;
  private options: Required<SupervisorOptions>;
  private status: DaemonStatus = { state: "stopped", source: "app", restarts: 0, paused: false };
  private daemon: LocalDaemon | undefined;
  private child: Child | undefined;
  private crashes = 0;
  private runningSince = 0;
  /** False once the app asked to stop: nothing may spawn or restart after that. */
  private wanted = false;
  private generation = 0;
  private transitions: Promise<void> = Promise.resolve();
  /** The one pending timer: a crash restart or the next health check. */
  private cancelTimer: (() => void) | undefined;
  private listeners = new Set<(status: DaemonStatus) => void>();
  private waiters = new Set<(daemon: LocalDaemon) => void>();

  constructor(ports: SupervisorPorts, options: SupervisorOptions = {}) {
    this.ports = ports;
    this.options = {
      healthIntervalMs: options.healthIntervalMs ?? 5_000,
      healthFailures: options.healthFailures ?? 3,
      // First start can import provider history before the endpoint is published.
      readyTimeoutMs: options.readyTimeoutMs ?? 120_000,
      stopGraceMs: options.stopGraceMs ?? 10_000,
      maxRestarts: options.maxRestarts ?? 5,
      stableMs: options.stableMs ?? 60_000,
    };
  }

  current(): DaemonStatus {
    return this.status;
  }
  onStatus(listener: (status: DaemonStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Resolves with the daemon's address once it is running. */
  ready(): Promise<LocalDaemon> {
    if (this.daemon && this.status.state === "running") return Promise.resolve(this.daemon);
    return new Promise((resolve) => this.waiters.add(resolve));
  }

  start(): Promise<void> {
    return this.transition(true, (generation) => this.bringUp(generation));
  }

  /** User-requested restart (the "repair" action): forgets earlier crashes. */
  async restart(): Promise<DaemonStatus> {
    await this.transition(true, async (generation) => {
      this.crashes = 0;
      await this.stopChild();
      await this.bringUp(generation);
    });
    return this.status;
  }

  /** Stops the daemon this app started (never another one) and anything pending. */
  stop(): Promise<void> {
    return this.transition(false, async () => {
      this.update({ state: "stopping" });
      await this.stopChild();
      this.daemon = undefined;
      this.update({ state: "stopped" });
    });
  }

  /** Close or reopen admission for new work (tray "Pause"); running turns continue. */
  async pause(on: boolean): Promise<DaemonStatus> {
    if (!this.daemon) throw new Error("The daemon is not running");
    await this.ports.setMaintenance(this.daemon, on);
    this.update({ paused: on });
    return this.status;
  }

  /**
   * Before an app update replaces the daemon: close admission and wait for running work to
   * finish naturally. Returns false (and reopens admission) if work remains at the deadline.
   */
  async drain(deadlineMs: number, pollMs = 1_000): Promise<boolean> {
    const daemon = this.daemon;
    if (!daemon || !this.child) return true;
    let blockers = await this.ports.setMaintenance(daemon, true);
    const until = this.ports.now() + deadlineMs;
    while (blockers > 0 && this.ports.now() < until) {
      await new Promise<void>((resolve) => this.ports.timers.set(pollMs, resolve));
      blockers = await this.ports.blockers(daemon);
    }
    if (blockers > 0) await this.ports.setMaintenance(daemon, false);
    this.update({ paused: blockers === 0 });
    return blockers === 0;
  }

  /**
   * Queue a lifecycle step. The generation and the wanted state change at once, so work
   * already in flight stops early; the step itself runs after the previous one finishes.
   */
  private transition(wanted: boolean, step: (generation: number) => Promise<void>): Promise<void> {
    const generation = ++this.generation;
    this.wanted = wanted;
    this.clearTimer();
    const run = this.transitions.then(() => step(generation));
    this.transitions = run.catch(() => {});
    return run;
  }

  private stale(generation: number): boolean {
    return generation !== this.generation || !this.wanted;
  }

  private async bringUp(generation: number): Promise<void> {
    if (this.stale(generation)) return;
    // Our own child is still alive (a second start): wait for it, never adopt it as external.
    const child = this.child;
    if (child && !child.done) return this.awaitChild(generation, child);
    this.update({ state: this.status.restarts ? "restarting" : "starting" });
    const existing = await this.ports.find();
    if (this.stale(generation)) return;
    if (existing) {
      const fromService = (await this.ports.service?.active().catch(() => false)) ?? false;
      if (!this.stale(generation)) this.running(existing, fromService ? "service" : "external");
      return;
    }
    if (await this.startService()) {
      const found = await this.waitForDaemon(generation, () => true);
      if (this.stale(generation)) return;
      if (found) return this.running(found, "service");
    }
    if (this.stale(generation)) return;
    const spawn = this.ports.spawn;
    if (!spawn) {
      for (;;) {
        const found = await this.waitForDaemon(generation, () => true);
        if (this.stale(generation)) return;
        if (found) return this.running(found, "external");
      }
    }
    this.awaitChild(generation, this.spawnChild(spawn));
  }

  private spawnChild(spawn: () => DaemonProcess): Child {
    const handle = spawn();
    let resolveExit: () => void = () => {};
    const child: Child = {
      process: handle,
      exited: new Promise((resolve) => (resolveExit = resolve)),
      done: false,
      intentional: false,
    };
    this.child = child;
    handle.onExit((code, signal) => {
      child.done = true;
      resolveExit();
      this.onChildExit(child, code, signal);
    });
    return child;
  }

  /** Report the child as running once it answers; kill it if it never does. */
  private awaitChild(generation: number, child: Child): void {
    void this.waitForDaemon(generation, () => !child.done).then((found) => {
      if (this.stale(generation) || child.done) return;
      if (found) this.running(found, "app");
      else {
        this.ports.log("error", "The daemon did not become ready; restarting it");
        child.process.kill("SIGKILL");
      }
    });
  }

  private onChildExit(child: Child, code: number | null, signal: string | null): void {
    if (this.child === child) this.child = undefined;
    // Stops this app asked for (restart, quit) are not crashes.
    if (child.intentional || !this.wanted) return;
    this.daemon = undefined;
    this.clearTimer();
    if (this.runningSince && this.ports.now() - this.runningSince >= this.options.stableMs)
      this.crashes = 0;
    this.runningSince = 0;
    const reason = `The daemon exited (${signal ?? `code ${code}`})`;
    if (this.crashes >= this.options.maxRestarts) {
      this.update({ state: "failed", message: `${reason}. Restart it or run diagnostics.` });
      return;
    }
    const delay = restartDelay(this.crashes++);
    this.ports.log("warn", `${reason}; restarting in ${delay} ms`);
    this.update({ state: "restarting", restarts: this.status.restarts + 1, message: reason });
    this.cancelTimer = this.ports.timers.set(delay, () => {
      this.cancelTimer = undefined;
      void this.start();
    });
  }

  private async startService(): Promise<boolean> {
    const service = this.ports.service;
    if (!service) return false;
    try {
      if (!(await service.active())) await service.start();
      return true;
    } catch (error) {
      this.ports.log("warn", `Login service did not start: ${String(error)}`);
      return false;
    }
  }

  private async waitForDaemon(
    generation: number,
    alive: () => boolean,
  ): Promise<LocalDaemon | undefined> {
    const deadline = this.ports.now() + this.options.readyTimeoutMs;
    while (!this.stale(generation) && alive() && this.ports.now() < deadline) {
      const found = await this.ports.find();
      if (found) return found;
      await new Promise<void>((resolve) => this.ports.timers.set(200, resolve));
    }
    return undefined;
  }

  private running(daemon: LocalDaemon, source: Source): void {
    this.daemon = daemon;
    this.runningSince = this.ports.now();
    const { message: _message, ...rest } = this.status;
    this.status = { ...rest, state: "running", source, url: daemon.url };
    this.emit();
    for (const resolve of this.waiters) resolve(daemon);
    this.waiters.clear();
    this.monitor(this.generation, daemon, 0);
  }

  private monitor(generation: number, daemon: LocalDaemon, failures: number): void {
    this.cancelTimer = this.ports.timers.set(this.options.healthIntervalMs, () => {
      this.cancelTimer = undefined;
      void this.ports.healthy(daemon).then((ok) => {
        if (this.stale(generation)) return;
        if (ok) return this.monitor(generation, daemon, 0);
        if (failures + 1 < this.options.healthFailures)
          return this.monitor(generation, daemon, failures + 1);
        this.ports.log("warn", "The daemon stopped answering health checks");
        this.daemon = undefined;
        // Our own hung child: kill it and let the crash path restart it.
        if (this.child && !this.child.done) this.child.process.kill("SIGKILL");
        else {
          // Someone else's daemon went away: run our own instead.
          this.update({ state: "unreachable" });
          void this.start();
        }
      });
    });
  }

  /** Stop our child on purpose: SIGTERM, then SIGKILL after the grace period. */
  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child || child.done) return;
    child.intentional = true;
    child.process.kill("SIGTERM");
    let cancel: (() => void) | undefined;
    const forced = new Promise<void>((resolve) => {
      cancel = this.ports.timers.set(this.options.stopGraceMs, () => {
        child.process.kill("SIGKILL");
        resolve();
      });
    });
    await Promise.race([child.exited, forced]);
    cancel?.();
    await child.exited;
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  private update(patch: Partial<DaemonStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit();
  }
  private emit(): void {
    for (const listener of this.listeners) listener(this.status);
  }
}

import type { DaemonStatus } from "../../shared/contract.ts";
import type { LocalDaemon } from "./probe.ts";

/** A daemon child process this app started. */
export interface DaemonProcess {
  kill(signal: NodeJS.Signals): void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface SupervisorPorts {
  /**
   * Start the bundled daemon with Electron's own Node (`ELECTRON_RUN_AS_NODE`). Without it
   * (development, attached to `bun run daemon`) the supervisor only waits for a daemon.
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

/**
 * Keeps one daemon available for this ACE_HOME. It reuses a running daemon (another app
 * window, the CLI or the login service) and only spawns its own when none answers. It
 * restarts only the daemon it started, with backoff, and never stops one it did not start.
 */
export class DaemonSupervisor {
  private ports: SupervisorPorts;
  private options: Required<SupervisorOptions>;
  private status: DaemonStatus = { state: "stopped", source: "app", restarts: 0, paused: false };
  private daemon: LocalDaemon | undefined;
  private child: DaemonProcess | undefined;
  private childExited: Promise<void> | undefined;
  private crashes = 0;
  private runningSince = 0;
  private stopping = false;
  private cancelTimer: (() => void) | undefined;
  private listeners = new Set<(status: DaemonStatus) => void>();
  private waiters = new Set<(daemon: LocalDaemon) => void>();
  private generation = 0;

  constructor(ports: SupervisorPorts, options: SupervisorOptions = {}) {
    this.ports = ports;
    this.options = {
      healthIntervalMs: options.healthIntervalMs ?? 5_000,
      healthFailures: options.healthFailures ?? 3,
      readyTimeoutMs: options.readyTimeoutMs ?? 30_000,
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

  async start(): Promise<void> {
    this.stopping = false;
    const generation = ++this.generation;
    this.update({ state: this.status.restarts ? "restarting" : "starting" });
    const existing = await this.ports.find();
    if (generation !== this.generation) return;
    if (existing) {
      const fromService = (await this.ports.service?.active().catch(() => false)) ?? false;
      this.running(existing, fromService ? "service" : "external");
      return;
    }
    if (await this.startService()) {
      const found = await this.waitForDaemon(generation, () => true);
      if (found) return this.running(found, "service");
    }
    if (generation !== this.generation) return;
    if (!this.ports.spawn) {
      for (;;) {
        const found = await this.waitForDaemon(generation, () => true);
        if (generation !== this.generation) return;
        if (found) return this.running(found, "external");
      }
    }
    this.spawnChild(generation, this.ports.spawn);
  }

  /** User-requested restart (the "repair" action): forgets earlier crashes. */
  async restart(): Promise<DaemonStatus> {
    this.crashes = 0;
    if (this.child) {
      await this.stopChild();
    }
    await this.start();
    return this.status;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.generation++;
    this.cancelTimer?.();
    this.update({ state: "stopping" });
    await this.stopChild();
    this.daemon = undefined;
    this.update({ state: "stopped" });
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

  private spawnChild(generation: number, spawn: () => DaemonProcess): void {
    let exited = false;
    const child = spawn();
    this.child = child;
    this.childExited = new Promise((resolve) =>
      child.onExit((code, signal) => {
        exited = true;
        if (this.child === child) this.child = undefined;
        resolve();
        this.onChildExit(generation, code, signal);
      }),
    );
    void this.waitForDaemon(generation, () => !exited).then((found) => {
      if (found) this.running(found, "app");
      else if (!exited && generation === this.generation) {
        this.ports.log("error", "The daemon did not become ready; restarting it");
        child.kill("SIGKILL");
      }
    });
  }

  private onChildExit(generation: number, code: number | null, signal: string | null): void {
    if (this.stopping || generation !== this.generation) return;
    this.daemon = undefined;
    this.cancelTimer?.();
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
    this.cancelTimer = this.ports.timers.set(delay, () => void this.start());
  }

  private async waitForDaemon(
    generation: number,
    alive: () => boolean,
  ): Promise<LocalDaemon | undefined> {
    const deadline = this.ports.now() + this.options.readyTimeoutMs;
    while (generation === this.generation && alive() && this.ports.now() < deadline) {
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
      void this.ports.healthy(daemon).then((ok) => {
        if (generation !== this.generation || this.stopping) return;
        if (ok) return this.monitor(generation, daemon, 0);
        if (failures + 1 < this.options.healthFailures)
          return this.monitor(generation, daemon, failures + 1);
        this.ports.log("warn", "The daemon stopped answering health checks");
        this.daemon = undefined;
        if (this.child) this.child.kill("SIGKILL");
        else {
          // Someone else's daemon went away: run our own instead.
          this.update({ state: "unreachable" });
          void this.start();
        }
      });
    });
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    const exited = this.childExited;
    if (!child || !exited) return;
    child.kill("SIGTERM");
    let cancel: (() => void) | undefined;
    const forced = new Promise<void>((resolve) => {
      cancel = this.ports.timers.set(this.options.stopGraceMs, () => {
        child.kill("SIGKILL");
        resolve();
      });
    });
    await Promise.race([exited, forced]);
    cancel?.();
    await exited;
  }

  private update(patch: Partial<DaemonStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit();
  }
  private emit(): void {
    for (const listener of this.listeners) listener(this.status);
  }
}

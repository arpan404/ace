import { exitCodes } from "@ace/service/exit-codes";
import type { DaemonStatus } from "../../shared/contract.ts";
import type { LocalDaemon } from "./probe.ts";
import { watchHealth } from "./watchdog.ts";

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

export interface SupervisorPorts {
  /**
   * Start the bundled daemon. Without it (development, attached to `bun run daemon`) the
   * supervisor only waits for a daemon.
   */
  spawn?: (() => DaemonProcess) | undefined;
  /** A healthy daemon already serving this ACE_HOME, if any. */
  find(): Promise<LocalDaemon | undefined>;
  /** Whether the daemon answers its status endpoint, giving up after `timeoutMs`. */
  healthy(daemon: LocalDaemon, timeoutMs: number): Promise<boolean>;
  /** The login service from `ace service install`, when one is installed. */
  service?: { active(): Promise<boolean>; start(): Promise<void> } | undefined;
  setMaintenance(daemon: LocalDaemon, on: boolean): Promise<number>;
  blockers(daemon: LocalDaemon): Promise<number>;
  maintenance(daemon: LocalDaemon): Promise<{ draining: boolean }>;
  timers: { set(delayMs: number, callback: () => void): () => void };
  now(): number;
  /** Every supervisor decision is logged with the facts behind it, so restarts can be explained. */
  log(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void;
}

export interface SupervisorOptions {
  /** Pause between one health check's outcome and the next. */
  healthIntervalMs?: number;
  /**
   * How long one health check waits before it counts as missed. The status endpoint runs on
   * the daemon's event loop, so a busy daemon (a long SQLite statement, a GC pause) answers
   * slowly without being hung.
   */
  healthTimeoutMs?: number;
  /** Consecutive missed health checks before the daemon is treated as gone. */
  healthFailures?: number;
  readyTimeoutMs?: number;
  /**
   * Between SIGTERM and SIGKILL, for any stop of the daemon this app started. Longer than the
   * daemon's own shutdown overrun (7.5 s), so a daemon that can still stop cleanly does.
   */
  stopGraceMs?: number;
  /**
   * Restarts in a row (without a stable run in between) before giving up and waiting for
   * the person to try again. With the default backoff, five give up after about 15 s.
   */
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
 * `ace start` refuses data written by a newer ace build with this exit code. Restarting
 * cannot help, so the supervisor stops and says what to do instead.
 */
const NEWER_DATA_EXIT = exitCodes["newer-data"];
export const newerDataMessage =
  "A newer version of ace already uses this data. Open the newest ace, or update this one.";

/** A status that will not turn into a running daemon without the repair flow or a restart. */
export function startFailed(status: DaemonStatus): boolean {
  if (status.state === "failed" || status.state === "stopping" || status.state === "stopped")
    return true;
  // A crash restart carries the exit as its message; a slow start or a user restart does not.
  return status.state === "restarting" && status.message !== undefined;
}

function failure(status: DaemonStatus): Error {
  return new Error(status.message ?? `The daemon is ${status.state}`);
}

/** What a daemon's exit code says about why it stopped, when it says anything. */
function exitCause(code: number | null): DaemonStatus["cause"] {
  return code === exitCodes["address-in-use"] ? "port-in-use" : undefined;
}

/** The status without the last exit's account, for a new attempt or a running daemon. */
function fresh(status: DaemonStatus): DaemonStatus {
  const { message: _message, cause: _cause, retry: _retry, ...rest } = status;
  return rest;
}

/** Why this app signalled its daemon: a repair or quit, a hung daemon, or one that never started. */
type StopReason = "requested" | "unresponsive" | "not-ready";

/** A child this app spawned. `intentional` is set before any stop this app asks for. */
interface Child {
  process: DaemonProcess;
  exited: Promise<void>;
  done: boolean;
  intentional: boolean;
  /** Set when this app signalled it, so its exit names the reason. */
  stopReason?: StopReason;
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
  /** "starting" from the outset: the app starts its supervisor as it launches. */
  private status: DaemonStatus = { state: "starting", source: "app", restarts: 0, paused: false };
  private daemon: LocalDaemon | undefined;
  private child: Child | undefined;
  private crashes = 0;
  private maintenanceRevision = 0;
  private draining = false;
  private runningSince = 0;
  /** False once the app asked to stop: nothing may spawn or restart after that. */
  private wanted = false;
  /** `stop()` is final: the app is quitting, so later starts and restarts do nothing. */
  private closed = false;
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
      healthTimeoutMs: options.healthTimeoutMs ?? 10_000,
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

  /**
   * Like `ready`, for a client waiting to connect: a slow start (a first start scans the
   * person's provider history before answering) is waited out however long it takes, while
   * a real failure rejects at once: our daemon exited (for example on the ACE_HOME lock of a
   * daemon that no longer answers), the supervisor gave up, or the app is stopping it.
   */
  reachable(): Promise<LocalDaemon> {
    if (startFailed(this.status)) return Promise.reject(failure(this.status));
    return new Promise((resolve, reject) => {
      const stop = this.onStatus((status) => {
        if (!startFailed(status)) return;
        stop();
        reject(failure(status));
      });
      void this.ready().then((daemon) => {
        stop();
        resolve(daemon);
      });
    });
  }

  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.transition(true, (generation) => this.bringUp(generation));
  }

  /** User-requested restart (the "repair" action): forgets earlier crashes. */
  async restart(): Promise<DaemonStatus> {
    if (this.closed) return this.status;
    await this.transition(true, async (generation) => {
      this.crashes = 0;
      // A repair starts fresh: the last crash no longer describes what happens next.
      this.status = fresh(this.status);
      await this.stopChild();
      await this.bringUp(generation);
    });
    return this.status;
  }

  /**
   * Stops the daemon this app started (never another one) and anything pending. Final: a
   * start that was still on its way (the login-shell PATH lookup) does nothing afterwards.
   */
  stop(): Promise<void> {
    this.closed = true;
    return this.transition(false, async () => {
      this.update({ state: "stopping" });
      await this.stopChild();
      this.daemon = undefined;
      this.update({ state: "stopped" });
    });
  }

  /** Close or reopen admission for new work (tray "Pause"); running turns continue. */
  async pause(on: boolean): Promise<DaemonStatus> {
    const daemon = this.daemon;
    if (!daemon || this.status.state !== "running") throw new Error("The daemon is not running");
    if (this.draining) throw new Error("The daemon is draining for an update");
    const generation = this.generation;
    const revision = ++this.maintenanceRevision;
    await this.ports.setMaintenance(daemon, on);
    if (!this.stale(generation) && this.daemon === daemon && revision === this.maintenanceRevision)
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
    const generation = this.generation;
    const wasPaused = this.status.paused;
    this.draining = true;
    ++this.maintenanceRevision;
    try {
      let blockers = await this.ports.setMaintenance(daemon, true);
      if (this.stale(generation) || this.daemon !== daemon) return false;
      this.update({ paused: true });
      const until = this.ports.now() + deadlineMs;
      while (blockers > 0 && this.ports.now() < until) {
        await new Promise<void>((resolve) => this.ports.timers.set(pollMs, resolve));
        if (this.stale(generation) || this.daemon !== daemon) return false;
        blockers = await this.ports.blockers(daemon);
      }
      if (this.stale(generation) || this.daemon !== daemon) return false;
      if (blockers > 0 && !wasPaused) await this.ports.setMaintenance(daemon, false);
      if (!this.stale(generation) && this.daemon === daemon)
        this.update({ paused: blockers === 0 || wasPaused });
      return blockers === 0;
    } finally {
      this.draining = false;
    }
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
      if (!this.stale(generation))
        await this.running(existing, fromService ? "service" : "external", generation);
      return;
    }
    if (await this.startService()) {
      const found = await this.waitForDaemon(generation, () => true);
      if (this.stale(generation)) return;
      if (found) return this.running(found, "service", generation);
    }
    if (this.stale(generation)) return;
    const spawn = this.ports.spawn;
    if (!spawn) {
      for (;;) {
        const found = await this.waitForDaemon(generation, () => true);
        if (this.stale(generation)) return;
        if (found) return this.running(found, "external", generation);
      }
    }
    let spawned: Child;
    try {
      spawned = this.spawnChild(spawn);
    } catch (error) {
      // Nothing to run (no bundled runtime, no entry): retrying cannot help.
      this.couldNotStart(error instanceof Error ? error.message : String(error));
      return;
    }
    this.awaitChild(generation, spawned);
  }

  private couldNotStart(reason: string): void {
    this.daemon = undefined;
    this.ports.log("error", "The daemon could not start", { reason });
    this.status = fresh(this.status);
    this.update({ state: "failed", message: `The daemon could not start: ${reason}` });
  }

  private spawnChild(spawn: () => DaemonProcess): Child {
    const handle = spawn();
    const exit = Promise.withResolvers<void>();
    const child: Child = { process: handle, exited: exit.promise, done: false, intentional: false };
    this.child = child;
    handle.onExit((code, signal, error) => {
      if (child.done) return;
      child.done = true;
      exit.resolve();
      this.onChildExit(child, code, signal, error);
    });
    return child;
  }

  /** Report the child as running once it answers; kill it if it never does. */
  private awaitChild(generation: number, child: Child): void {
    void this.waitForDaemon(generation, () => !child.done).then(async (found) => {
      if (this.stale(generation) || child.done) return;
      if (found) await this.running(found, "app", generation);
      else {
        this.ports.log("error", "The daemon did not become ready; restarting it", {
          readyTimeoutMs: this.options.readyTimeoutMs,
        });
        this.terminate(child, "not-ready");
      }
    });
  }

  private onChildExit(
    child: Child,
    code: number | null,
    signal: string | null,
    error: string | undefined,
  ): void {
    if (this.child === child) this.child = undefined;
    const exit = { code, signal, ...(child.stopReason ? { stoppedBy: child.stopReason } : {}) };
    // Stops this app asked for (restart, quit) are not crashes.
    if (child.intentional || !this.wanted) {
      this.ports.log("info", "The daemon exited", exit);
      return;
    }
    if (error !== undefined) {
      this.clearTimer();
      this.couldNotStart(error);
      return;
    }
    this.daemon = undefined;
    this.clearTimer();
    if (this.runningSince && this.ports.now() - this.runningSince >= this.options.stableMs)
      this.crashes = 0;
    this.runningSince = 0;
    if (code === NEWER_DATA_EXIT) {
      // Its data belongs to a newer build: every restart would refuse it the same way.
      this.ports.log(
        "error",
        "The daemon refused data written by a newer ace; not restarting it",
        exit,
      );
      this.status = fresh(this.status);
      this.update({ state: "failed", message: newerDataMessage });
      return;
    }
    this.ports.log("warn", "The daemon exited unexpectedly", exit);
    const reason = `The daemon exited (${signal ?? `code ${code}`})`;
    const cause = exitCause(code);
    this.status = fresh(this.status);
    if (cause) this.status.cause = cause;
    if (this.crashes >= this.options.maxRestarts) {
      this.ports.log("error", `${reason}; gave up after ${this.crashes} restarts`, {
        ...exit,
        restarts: this.crashes,
      });
      this.update({ state: "failed", message: `${reason}. Restart it or run diagnostics.` });
      return;
    }
    const delay = restartDelay(this.crashes++);
    this.ports.log("warn", `${reason}; restarting in ${delay} ms`, {
      ...exit,
      delayMs: delay,
      attempt: this.crashes,
      of: this.options.maxRestarts,
    });
    this.update({
      state: "restarting",
      restarts: this.status.restarts + 1,
      message: reason,
      retry: { attempt: this.crashes, of: this.options.maxRestarts },
    });
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
      this.ports.log("warn", "Login service did not start", { error: String(error) });
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

  private async running(daemon: LocalDaemon, source: Source, generation: number): Promise<void> {
    const deadline = this.ports.now() + this.options.readyTimeoutMs;
    let admission: { draining: boolean } | undefined;
    while (!this.stale(generation)) {
      if (source === "app" && (!this.child || this.child.done)) return;
      try {
        admission = await this.ports.maintenance(daemon);
        break;
      } catch (error) {
        if (this.stale(generation) || (source === "app" && (!this.child || this.child.done)))
          return;
        if (this.ports.now() >= deadline) {
          this.couldNotStart(`Cannot read daemon admission: ${String(error)}`);
          return;
        }
        this.ports.log("warn", "Cannot read daemon admission yet", { error: String(error) });
        await new Promise<void>((resolve) => this.ports.timers.set(200, resolve));
      }
    }
    if (
      !admission ||
      this.stale(generation) ||
      (source === "app" && (!this.child || this.child.done))
    )
      return;
    this.daemon = daemon;
    this.runningSince = this.ports.now();
    this.status = {
      ...fresh(this.status),
      state: "running",
      source,
      url: daemon.url,
      paused: admission.draining,
    };
    this.emit();
    for (const resolve of this.waiters) resolve(daemon);
    this.waiters.clear();
    this.monitor(this.generation, daemon);
  }

  private monitor(generation: number, daemon: LocalDaemon): void {
    const { healthIntervalMs, healthTimeoutMs, healthFailures } = this.options;
    // The one pending timer is the watch itself; any transition stops it.
    this.cancelTimer = watchHealth({
      intervalMs: healthIntervalMs,
      timeoutMs: healthTimeoutMs,
      failures: healthFailures,
      // The request itself may run past the check's own deadline, so a late answer still
      // counts as one; it ends before the next check could send another.
      probe: () => this.ports.healthy(daemon, healthTimeoutMs + healthIntervalMs),
      timers: this.ports.timers,
      log: (level, message, data) => {
        if (!this.stale(generation)) this.ports.log(level, message, data);
      },
      onUnresponsive: (missed) => {
        this.cancelTimer = undefined;
        if (this.stale(generation)) return;
        this.daemon = undefined;
        const facts = { missed, timeoutMs: healthTimeoutMs, intervalMs: healthIntervalMs };
        this.update({ state: "unreachable" });
        const child = this.child;
        if (child && !child.done) {
          // Our own daemon: ask it to stop, and let the crash path restart it.
          this.ports.log("error", "The daemon stopped answering health checks; stopping it", facts);
          this.terminate(child, "unresponsive");
          return;
        }
        // Someone else's daemon went away: run our own instead.
        this.ports.log("warn", "The daemon stopped answering health checks", facts);
        void this.start();
      },
    });
  }

  /**
   * Stop our child without marking the stop intentional, so its exit takes the crash path
   * and restarts: SIGTERM, then SIGKILL only if it is still running after the grace period.
   */
  private terminate(child: Child, reason: StopReason): void {
    const graceMs = this.options.stopGraceMs;
    child.stopReason = reason;
    this.ports.log("warn", "Sending SIGTERM to the daemon", { reason, graceMs });
    child.process.kill("SIGTERM");
    const cancel = this.ports.timers.set(graceMs, () => {
      // A repair or quit since then runs its own escalation.
      if (child.done || child.intentional) return;
      this.ports.log("error", "The daemon did not exit after SIGTERM; sending SIGKILL", {
        reason,
        graceMs,
      });
      child.process.kill("SIGKILL");
    });
    void child.exited.then(cancel);
  }

  /** Stop our child on purpose: SIGTERM, then SIGKILL after the grace period. */
  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child || child.done) return;
    child.intentional = true;
    child.stopReason = "requested";
    const graceMs = this.options.stopGraceMs;
    this.ports.log("info", "Stopping the daemon", { graceMs });
    child.process.kill("SIGTERM");
    let cancel: (() => void) | undefined;
    const forced = new Promise<void>((resolve) => {
      cancel = this.ports.timers.set(graceMs, () => {
        this.ports.log("warn", "The daemon did not exit after SIGTERM; sending SIGKILL", {
          reason: "requested",
          graceMs,
        });
        child.process.kill("SIGKILL");
        resolve();
      });
    });
    await Promise.race([child.exited, forced]);
    cancel?.();
    if (child.done) return;
    // SIGKILL cannot be ignored, but a process that never reports its exit must not hold
    // up repair or quit forever.
    let gaveUp = false;
    let cancelWait: (() => void) | undefined;
    const bound = new Promise<void>((resolve) => {
      cancelWait = this.ports.timers.set(this.options.stopGraceMs, () => {
        gaveUp = true;
        resolve();
      });
    });
    await Promise.race([child.exited, bound]);
    cancelWait?.();
    if (gaveUp && !child.done) {
      this.ports.log("error", "The daemon did not report its exit after SIGKILL");
      child.done = true;
      if (this.child === child) this.child = undefined;
    }
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

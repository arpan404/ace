import type { DaemonStatus } from "../../shared/contract.ts";
import {
  stopChild,
  terminate,
  trackChild,
  type Child,
  type DaemonProcess,
  type StopPorts,
  type StopReason,
} from "./child.ts";
import { drainForUpdate } from "./drain.ts";
import {
  exitDecision,
  incompatibleDataMessage,
  lockHeldMessage,
  newerDataMessage,
} from "./exit-policy.ts";
import type { LocalDaemon } from "./probe.ts";
import { readAdmission, waitForDaemon } from "./readiness.ts";
import { failure, fresh, startFailed } from "./status.ts";
import { watchHealth } from "./watchdog.ts";

import {
  supervisorDefaults,
  type SupervisorOptions,
  type SupervisorPorts,
} from "./supervisor-config.ts";

export type { DaemonProcess } from "./child.ts";
export { incompatibleDataMessage, lockHeldMessage, newerDataMessage } from "./exit-policy.ts";
export type { SupervisorOptions, SupervisorPorts } from "./supervisor-config.ts";

type Source = DaemonStatus["source"];

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
  /** When our daemons first started finding another daemon's lock, while that lasts. */
  private lockWaitSince: number | undefined;
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
    this.options = supervisorDefaults(options);
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
      this.lockWaitSince = undefined;
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

  /** Threads still at work in the daemon this app started; 0 when it started none. */
  async busy(): Promise<number> {
    const daemon = this.daemon;
    if (!daemon || !this.child) return 0;
    return this.ports.blockers(daemon);
  }

  /**
   * Before an app update replaces the daemon: close admission and wait for running work to
   * finish naturally. Returns false (and reopens admission) if work remains at the deadline.
   */
  async drain(
    deadlineMs: number,
    pollMs = 1_000,
    waiting?: (count: number) => void,
  ): Promise<boolean> {
    const daemon = this.daemon;
    if (!daemon || !this.child) return true;
    const generation = this.generation;
    this.draining = true;
    ++this.maintenanceRevision;
    try {
      return await drainForUpdate(this.ports, daemon, {
        deadlineMs,
        pollMs,
        wasPaused: this.status.paused,
        current: () => !this.stale(generation) && this.daemon === daemon,
        paused: (on) => this.update({ paused: on }),
        ...(waiting ? { waiting } : {}),
      });
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
    if (existing) return this.adopt(existing, generation);
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

  /** A daemon this app did not start answers for this home: use it. */
  private async adopt(daemon: LocalDaemon, generation: number): Promise<void> {
    const fromService = (await this.ports.service?.active().catch(() => false)) ?? false;
    if (!this.stale(generation))
      await this.running(daemon, fromService ? "service" : "external", generation);
  }

  /**
   * Our daemon found another daemon's lock on this home. That one is still starting (it
   * answers once ready, and is adopted) or stopping (it lets go, and ours starts). Neither is
   * a crash, so no restart is counted; only a lock held past `lockWaitMs` is a failure.
   */
  private lockHeld(exit: Record<string, unknown>): void {
    const now = this.ports.now();
    this.lockWaitSince ??= now;
    const waitedMs = now - this.lockWaitSince;
    this.status = fresh(this.status);
    if (waitedMs >= this.options.lockWaitMs) {
      this.lockWaitSince = undefined;
      this.ports.log("error", "Another ace daemon kept this home's lock; stopped waiting", {
        ...exit,
        waitedMs,
      });
      this.update({ state: "failed", cause: "lock-held", message: lockHeldMessage });
      return;
    }
    this.ports.log("info", "Another ace daemon holds this home's lock; waiting for it", {
      ...exit,
      waitedMs,
    });
    // Starting, not failed: a client waiting to connect keeps waiting.
    this.update({ state: "starting", cause: "lock-held" });
    void this.transition(true, (generation) => this.awaitLock(generation));
  }

  /** Look for the other daemon for a while, then try our own again. */
  private async awaitLock(generation: number): Promise<void> {
    const found = await waitForDaemon(
      this.ports,
      this.options.lockRetryMs,
      () => !this.stale(generation),
    );
    if (this.stale(generation)) return;
    if (found) return this.adopt(found, generation);
    return this.bringUp(generation);
  }

  private couldNotStart(reason: string): void {
    this.daemon = undefined;
    this.ports.log("error", "The daemon could not start", { reason });
    this.status = fresh(this.status);
    this.update({ state: "failed", message: `The daemon could not start: ${reason}` });
  }

  private spawnChild(spawn: () => DaemonProcess): Child {
    const child = trackChild(spawn(), (exited, code, signal, error) =>
      this.onChildExit(exited, code, signal, error),
    );
    this.child = child;
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
    const decision = exitDecision({
      code,
      signal,
      crashes: this.crashes,
      maxRestarts: this.options.maxRestarts,
    });
    if (decision.kind === "incompatible-data") {
      this.ports.log(
        "error",
        "The daemon stopped on saved data it cannot read; not restarting it",
        exit,
      );
      this.status = fresh(this.status);
      this.update({ state: "failed", message: incompatibleDataMessage });
      return;
    }
    if (decision.kind === "lock-held") return this.lockHeld(exit);
    // Any other exit ends a wait on another daemon's lock.
    this.lockWaitSince = undefined;
    if (decision.kind === "newer-data") {
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
    const { reason, cause } = decision;
    this.status = fresh(this.status);
    if (cause) this.status.cause = cause;
    if (decision.kind === "give-up") {
      this.ports.log("error", `${reason}; gave up after ${this.crashes} restarts`, {
        ...exit,
        restarts: this.crashes,
      });
      this.update({ state: "failed", message: `${reason}. Restart it or run diagnostics.` });
      return;
    }
    const delay = decision.delayMs;
    this.crashes++;
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

  private waitForDaemon(generation: number, alive: () => boolean) {
    return waitForDaemon(
      this.ports,
      this.options.readyTimeoutMs,
      () => !this.stale(generation) && alive(),
    );
  }

  private async running(daemon: LocalDaemon, source: Source, generation: number): Promise<void> {
    // A daemon this app started counts only while that child is still alive.
    const live = () =>
      !this.stale(generation) && (source !== "app" || (!!this.child && !this.child.done));
    const admission = await readAdmission(this.ports, daemon, this.options.readyTimeoutMs, live);
    if (admission.kind === "failed") return this.couldNotStart(admission.reason);
    if (admission.kind === "abandoned" || !live()) return;
    this.daemon = daemon;
    this.lockWaitSince = undefined;
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

  private stopPorts(): StopPorts {
    return {
      graceMs: this.options.stopGraceMs,
      timers: this.ports.timers,
      log: (level, message, data) => this.ports.log(level, message, data),
    };
  }

  /** Signal our child so its exit takes the crash path and restarts it. */
  private terminate(child: Child, reason: StopReason): void {
    terminate(child, reason, this.stopPorts());
  }

  /** Stop our child on purpose (repair, quit); its exit is not a crash. */
  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child || child.done) return;
    await stopChild(child, this.stopPorts());
    // A child given up on after SIGKILL never reports its exit, so it is forgotten here.
    if (child.done && this.child === child) this.child = undefined;
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

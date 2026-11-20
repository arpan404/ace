import type { DaemonProcess } from "./child.ts";
import type { EndpointWatch } from "./readiness.ts";
import type { FreezeSignal } from "./watchdog.ts";
import type { AdmissionFacts, Health, LocalDaemon } from "./probe.ts";

/** A daemon an earlier launch of this app started and left running (ADR 0186). */
export interface OwnedDaemon {
  /** A handle to stop it and to notice its exit, though it is not this process's child. */
  process: DaemonProcess;
  /** Started by another version of the app: replaced by the bundled daemon, never served from. */
  replace: boolean;
  /** The app version that started it. */
  version: string;
}

/** Everything the supervisor does to the world, passed in so tests substitute it. */
export interface SupervisorPorts {
  /**
   * Start the bundled daemon. Without it (development, attached to `bun run daemon`) the
   * supervisor only waits for a daemon.
   */
  spawn?: ((launch: { safeMode: boolean }) => DaemonProcess) | undefined;
  /**
   * Settles once a spawn has what it needs (the login shell's PATH). Awaited only on the way to
   * spawning, so adopting a daemon that already runs never waits on it.
   */
  prepareSpawn?: (() => Promise<void>) | undefined;
  /** Watches the home's endpoint file while a start waits (`readiness.ts`); else it polls. */
  watchEndpoint?: (() => EndpointWatch | undefined) | undefined;
  /** A healthy daemon already serving this ACE_HOME, if any. */
  find(): Promise<LocalDaemon | undefined>;
  /**
   * The found daemon, when an earlier launch of this app started it (its ownership record names
   * the run holding the home's lock). Undefined for anyone else's: the CLI's, the login
   * service's. Without it every found daemon is someone else's.
   */
  claimOwned?: ((daemon: LocalDaemon) => Promise<OwnedDaemon | undefined>) | undefined;
  /**
   * Records the daemon this app spawned as the app's, so a later launch adopts it. False when it
   * could not be recorded (it has not taken the home's lock yet).
   */
  recordOwned?: ((process: DaemonProcess) => Promise<boolean>) | undefined;
  /**
   * Whether the daemon answers its status endpoint, giving up after `timeoutMs`; with its
   * admission when the daemon includes it.
   */
  health(daemon: LocalDaemon, timeoutMs: number): Promise<Health>;
  /** The login service from `ace service install`, when one is installed. */
  service?: { active(): Promise<boolean>; start(): Promise<void> } | undefined;
  /** The person's pause (the tray's control); resolves with the work still running. */
  setMaintenance(daemon: LocalDaemon, on: boolean): Promise<number>;
  /** An update's own hold, apart from the person's pause (`drain.ts`). */
  setUpdateHold(daemon: LocalDaemon, on: boolean): Promise<number>;
  blockers(daemon: LocalDaemon): Promise<number>;
  /** `holds` names what closes admission; daemons that predate holds omit it. */
  maintenance(daemon: LocalDaemon): Promise<AdmissionFacts>;
  timers: { set(delayMs: number, callback: () => void): () => void };
  now(): number;
  /** The app's one main-thread beat, so health checks need no beat of their own. */
  freezes?: FreezeSignal | undefined;
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
  /** Fast failures in a row before the next start is in safe mode. */
  safeModeAfter?: number;
  /**
   * How long to wait out another daemon holding this home's lock (one still starting on a
   * large database, or still shutting down) before saying so as a failure.
   */
  lockWaitMs?: number;
  /** While waiting on that lock: how long to look for the other daemon before spawning again. */
  lockRetryMs?: number;
  /**
   * How long running work may take to finish in the app's own daemon from another version,
   * found at launch, before it is stopped and replaced anyway. The update drain's bound.
   */
  replaceDrainMs?: number;
}

export function supervisorDefaults(options: SupervisorOptions): Required<SupervisorOptions> {
  return {
    healthIntervalMs: options.healthIntervalMs ?? 5_000,
    healthTimeoutMs: options.healthTimeoutMs ?? 10_000,
    healthFailures: options.healthFailures ?? 3,
    // First start can import provider history before the endpoint is published.
    readyTimeoutMs: options.readyTimeoutMs ?? 120_000,
    stopGraceMs: options.stopGraceMs ?? 10_000,
    maxRestarts: options.maxRestarts ?? 5,
    stableMs: options.stableMs ?? 60_000,
    safeModeAfter: options.safeModeAfter ?? 2,
    lockWaitMs: options.lockWaitMs ?? 300_000,
    lockRetryMs: options.lockRetryMs ?? 5_000,
    replaceDrainMs: options.replaceDrainMs ?? 5 * 60_000,
  };
}

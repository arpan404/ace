/*
 * The daemon's owner of the locked use service: `ace-screen-helper --locked-use --socket
 * <path>`, started on first use, restarted after it exits, and its one socket connection.
 * It keeps the service's latest status and runs one protected attempt at a time. Nothing
 * here starts unless asked, so with locked use off the service never runs.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  LockedUseConnection,
  connectLockedUse,
  runProtectedAttempt,
  type LockedUseServiceStatus,
  type LockedUseTurnScope,
  type Scheduler,
} from "@ace/screen";

export interface LockedUseRuntimeOptions {
  /** The installed helper executable; resolved before every start. */
  helper: () => Promise<string>;
  socketPath: string;
  nextId: () => string;
  /** A fresh, unguessable attempt id each call. */
  attemptId: () => string;
  scheduler: Scheduler;
  spawnService?: (command: string, args: readonly string[]) => ChildProcess;
  connect?: (path: string) => Promise<Socket>;
  /** How long a started service may take to accept the connection. */
  connectTimeoutMs?: number;
  readyTimeoutMs?: number;
  relockTimeoutMs?: number;
}

const retryMs = 50;

/**
 * Service phases in which the Mac may be unlocked by locked use rather than by the person:
 * from covering until relock is confirmed, and indefinitely while faulted.
 */
const intervalPhases: ReadonlySet<string> = new Set([
  "covering",
  "authorizing",
  "unlocking",
  "working",
  "relocking",
  "faulted",
]);

export class LockedUseRuntime {
  readonly #options: LockedUseRuntimeOptions;
  #status: LockedUseServiceStatus | undefined;
  #connection: LockedUseConnection | undefined;
  #connecting: Promise<LockedUseConnection> | undefined;
  #child: ChildProcess | undefined;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  /** Protected runs queued or in flight; each can cancel its own attempt. */
  readonly #runs = new Set<AbortController>();
  /** The newest attempt whose completion arrived: the service confirmed the Mac relocked. */
  #relocked: string | undefined;

  constructor(options: LockedUseRuntimeOptions) {
    this.#options = options;
  }

  /** The newest status the service reported, while connected. */
  get status(): LockedUseServiceStatus | undefined {
    return this.#status;
  }

  /** The installation is verified and the Mac is locked, by the newest status. */
  verifiedAndLocked(): boolean {
    return this.#status?.installation.verified === true && this.#status.session === "locked";
  }

  /**
   * Whether a protected interval is underway or may still hold the Mac unlocked: a protected
   * run is queued or in flight, or the service's newest phase is between covering and a
   * confirmed relock (or faulted). While true, only that run may act on the Mac.
   */
  intervalActive(): boolean {
    if (this.#runs.size > 0) return true;
    const status = this.#status;
    if (!status || !intervalPhases.has(status.phase)) return false;
    // The `relocking` state can trail its attempt's completion, which already confirmed it.
    return !(status.phase === "relocking" && status.attemptID === this.#relocked);
  }

  /** Stops every queued or running protected attempt; each relocks and reports cancelled. */
  cancelActive(): void {
    for (const run of this.#runs) run.abort();
  }

  /** Reads a fresh status, starting and connecting to the service if needed. */
  async refresh(): Promise<LockedUseServiceStatus | undefined> {
    const connection = await this.#connect();
    const status = await connection.request({ type: "status" });
    if (status && this.#connection === connection) this.#status = status;
    return status;
  }

  /**
   * Runs `work` inside one protected interval for the approved turn `scope`. Attempts run one
   * at a time; each gets a fresh attempt id. Rejects, without running `work`, unless the
   * service reaches `working` for this attempt.
   */
  runProtected<T>(
    scope: LockedUseTurnScope,
    agentProcessIDs: readonly number[],
    work: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const stop = new AbortController();
    this.#runs.add(stop);
    const stopped = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    const run = this.#tail
      .then(async () => {
        const connection = await this.#connect();
        return runProtectedAttempt(connection, {
          ...scope,
          agentProcessIDs,
          attemptID: this.#options.attemptId(),
          work,
          scheduler: this.#options.scheduler,
          signal: stopped,
          ...(this.#options.readyTimeoutMs ? { readyTimeoutMs: this.#options.readyTimeoutMs } : {}),
          ...(this.#options.relockTimeoutMs
            ? { relockTimeoutMs: this.#options.relockTimeoutMs }
            : {}),
        });
      })
      .finally(() => this.#runs.delete(stop));
    this.#tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  close(): void {
    this.#closed = true;
    this.#connection?.close();
    this.#connection = undefined;
    this.#status = undefined;
    this.#child?.kill("SIGTERM");
    this.#child = undefined;
  }

  #connect(): Promise<LockedUseConnection> {
    if (this.#closed) return Promise.reject(new Error("Locked use is shutting down"));
    const live = this.#connection;
    if (live && !live.closed) return Promise.resolve(live);
    this.#connecting ??= this.#open().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #open(): Promise<LockedUseConnection> {
    const socket = await this.#dial();
    if (this.#closed) {
      socket.destroy();
      throw new Error("Locked use is shutting down");
    }
    const connection = new LockedUseConnection(socket, {
      nextId: this.#options.nextId,
      scheduler: this.#options.scheduler,
    });
    connection.onEvent((event) => {
      if (this.#connection !== connection) return;
      if (event.type === "state") this.#status = event.status;
      else if (event.type === "completion" && event.attemptID) this.#relocked = event.attemptID;
    });
    connection.onClose(() => {
      if (this.#connection !== connection) return;
      this.#connection = undefined;
      this.#status = undefined;
    });
    this.#connection = connection;
    return connection;
  }

  async #start(): Promise<void> {
    const command = await this.#options.helper();
    if (this.#closed) throw new Error("Locked use is shutting down");
    const started = (this.#options.spawnService ?? defaultSpawn)(command, [
      "--locked-use",
      "--socket",
      this.#options.socketPath,
    ]);
    started.on("error", () => {});
    started.stderr?.resume();
    // The service going away ends its connection, and with it any attempt.
    started.once("exit", () => {
      if (this.#child !== started) return;
      this.#child = undefined;
      this.#connection?.close();
    });
    this.#child = started;
  }

  /**
   * Connects, starting the service when none is running. It creates its socket after it
   * starts, so a refused connection is retried, restarting a service that exited meanwhile,
   * until it accepts or time runs out.
   */
  async #dial(): Promise<Socket> {
    const connect = this.#options.connect ?? connectLockedUse;
    const limit = this.#options.connectTimeoutMs ?? 5_000;
    let waited = 0;
    for (;;) {
      if (!this.#running()) await this.#start();
      try {
        return await connect(this.#options.socketPath);
      } catch (error) {
        if (this.#closed) throw error;
        if (waited >= limit) {
          // A service that never accepts is replaced on the next use.
          this.#child?.kill("SIGTERM");
          throw error;
        }
      }
      await new Promise<void>((resolve) => this.#options.scheduler.after(retryMs, resolve));
      waited += retryMs;
    }
  }

  #running(): boolean {
    const child = this.#child;
    return !!child && child.exitCode === null && child.signalCode === null;
  }
}

/** macOS refuses Unix socket paths over 103 bytes. */
const maxSocketPath = 103;

/** The service's socket: in the data dir, or the temp dir when that path is too long. */
export function lockedUseSocketPath(dataDir: string): string {
  const preferred = join(dataDir, "locked-use.sock");
  if (Buffer.byteLength(preferred) <= maxSocketPath) return preferred;
  return join(tmpdir(), `ace-locked-use-${userInfo().uid}.sock`);
}

function defaultSpawn(command: string, args: readonly string[]): ChildProcess {
  return spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"] });
}

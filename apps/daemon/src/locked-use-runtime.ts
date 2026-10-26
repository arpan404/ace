/*
 * The daemon's owner of the locked use service: `ace-screen-helper --locked-use --socket
 * <path>`, started on first use, restarted after it exits, and its one socket connection.
 * It keeps the service's latest status and runs one protected attempt at a time. Nothing
 * here starts unless asked, so with locked use off the service never runs.
 *
 * The service serves only this daemon: each start gets a fresh 32-byte token, written to its
 * stdin as one line of hex, and every connection opens with a `hello` carrying it. Stdin stays
 * open for the service's life; closing it tells the service the daemon is gone, so it relocks
 * and exits.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  LockedUseAttemptError,
  LockedUseConnection,
  connectLockedUse,
  runProtectedAttempt,
  type LockedUseServiceStatus,
  type LockedUseTurnScope,
  type Scheduler,
} from "@ace/screen";
import { UnprotectedSends } from "./locked-use-in-flight.ts";

export interface LockedUseRuntimeOptions {
  /** The installed helper executable; resolved before every start. */
  helper: () => Promise<string>;
  socketPath: string;
  nextId: () => string;
  /** A fresh, unguessable attempt id each call. */
  attemptId: () => string;
  scheduler: Scheduler;
  /** Starts the service with stdin piped: the token goes there and it stays open. */
  spawnService?: (command: string, args: readonly string[]) => ChildProcess;
  /** Cryptographic random bytes, for each start's token. */
  randomBytes?: (size: number) => Uint8Array;
  /** How long the service may take to accept a connection's hello. */
  helloTimeoutMs?: number;
  connect?: (path: string) => Promise<Socket>;
  /** How long a started service may take to accept the connection. */
  connectTimeoutMs?: number;
  readyTimeoutMs?: number;
  relockTimeoutMs?: number;
  /**
   * How long a protected attempt waits for computer requests already sent outside any
   * interval to settle before it is refused. Defaults past the helper's longest deadline.
   */
  drainTimeoutMs?: number;
}

const retryMs = 50;
/** The helper's longest request deadline (an act, 85s) plus its cancel grace. */
const defaultDrainTimeoutMs = 90_000;
const notRun = "Nothing ran in the app; the Mac stays locked.";

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
  /** The running service's token; it answers no one without it. */
  #token: string | undefined;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  /** Protected runs queued or in flight; each can cancel its own attempt. */
  readonly #runs = new Set<AbortController>();
  /** The newest attempt whose completion arrived: the service confirmed the Mac relocked. */
  #relocked: string | undefined;
  /** Computer requests in flight outside any protected interval. */
  readonly #unprotected = new UnprotectedSends();
  /**
   * The service connection ended while an interval may have held the Mac unlocked. Only a
   * fresh status showing the session locked again clears it.
   */
  #heldOnDrop = false;
  #recovering: Promise<void> | undefined;

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
   * run is queued or in flight, the service's newest phase is between covering and a
   * confirmed relock (or faulted), or the connection ended during one and no fresh status has
   * shown the Mac locked since. While true, only that run may act on the Mac.
   */
  intervalActive(): boolean {
    if (this.#runs.size > 0) return true;
    if (this.#heldOnDrop) {
      // Fails closed until a fresh status shows the Mac locked again; asking is how it clears.
      this.#recover();
      return true;
    }
    return this.#holdsInterval(this.#status);
  }

  /**
   * Sends one computer request outside any protected interval. It counts as in flight from
   * this call until it settles, and no protected attempt begins while any is in flight.
   */
  runUnprotected<T>(send: () => Promise<T>): Promise<T> {
    return this.#unprotected.track(send);
  }

  /** Stops every queued or running protected attempt; each relocks and reports cancelled. */
  cancelActive(): void {
    for (const run of this.#runs) run.abort();
  }

  /** Reads a fresh status, starting and connecting to the service if needed. */
  async refresh(): Promise<LockedUseServiceStatus | undefined> {
    const connection = await this.#connect();
    const status = await connection.request({ type: "status" });
    if (status && this.#connection === connection) this.#observe(status);
    return status;
  }

  /** A fresh status from the live connection. */
  #observe(status: LockedUseServiceStatus): void {
    this.#status = status;
    if (status.session === "locked") this.#heldOnDrop = false;
  }

  /** The service's phase is between covering and a confirmed relock, or faulted. */
  #holdsInterval(status: LockedUseServiceStatus | undefined): boolean {
    if (!status || !intervalPhases.has(status.phase)) return false;
    // The `relocking` state can trail its attempt's completion, which already confirmed it.
    return !(status.phase === "relocking" && status.attemptID === this.#relocked);
  }

  /** Asks for a fresh status, one request at a time, so a held interval can clear. */
  #recover(): void {
    if (this.#recovering || this.#closed) return;
    this.#recovering = this.refresh().then(
      () => {
        this.#recovering = undefined;
      },
      () => {
        this.#recovering = undefined;
      },
    );
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
    signal: AbortSignal | undefined,
    optIn: boolean,
  ): Promise<T> {
    const stop = new AbortController();
    this.#runs.add(stop);
    const stopped = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    const run = this.#tail
      .then(async () => {
        // A request sent before this run was queued may still be acting on the desktop: the
        // Mac is never unlocked under it.
        const drained = await this.#unprotected.drained(
          this.#options.drainTimeoutMs ?? defaultDrainTimeoutMs,
          this.#options.scheduler,
          stopped,
        );
        if (stopped.aborted) throw new LockedUseAttemptError("cancelled", `Cancelled. ${notRun}`);
        if (!drained)
          throw new LockedUseAttemptError(
            "locked_use_busy",
            `Another computer step is still running on this Mac. ${notRun}`,
          );
        const connection = await this.#connect();
        return runProtectedAttempt(connection, {
          ...scope,
          agentProcessIDs,
          attemptID: this.#options.attemptId(),
          optIn,
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
    this.#stop();
  }

  /** Ends the running service: closing its stdin tells it the daemon is gone. */
  #stop(): void {
    this.#child?.stdin?.end();
    this.#child?.kill("SIGTERM");
    this.#child = undefined;
    this.#token = undefined;
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
    const token = this.#token;
    const connection = new LockedUseConnection(socket, {
      nextId: this.#options.nextId,
      scheduler: this.#options.scheduler,
      ...(this.#options.randomBytes ? { randomBytes: this.#options.randomBytes } : {}),
    });
    connection.onEvent((event) => {
      if (this.#connection !== connection) return;
      if (event.type === "state") this.#observe(event.status);
      else if (event.type === "completion" && event.attemptID) this.#relocked = event.attemptID;
    });
    connection.onClose(() => {
      if (this.#connection !== connection) return;
      // A service that died mid-interval may leave the Mac unlocked until its guardian
      // relocks it: losing the connection never ends the interval.
      if (this.#runs.size > 0 || this.#holdsInterval(this.#status)) this.#heldOnDrop = true;
      this.#connection = undefined;
      this.#status = undefined;
    });
    // Listeners first, so a state sent right after the accept isn't missed.
    try {
      if (!token) throw new Error("Locked use service has no token");
      await connection.authenticate(token, this.#options.helloTimeoutMs);
    } catch (error) {
      connection.close();
      // A service that won't accept this daemon is replaced on the next use.
      this.#stop();
      throw error;
    }
    if (this.#closed) {
      connection.close();
      throw new Error("Locked use is shutting down");
    }
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
    if (!started.stdin) {
      started.kill("SIGTERM");
      throw new Error("Locked use service has no stdin for its token");
    }
    // A service that exits early makes this write fail; the exit is handled below.
    started.stdin.on("error", () => {});
    const token = Buffer.from((this.#options.randomBytes ?? randomBytes)(32)).toString("hex");
    started.stdin.write(`${token}\n`);
    // The service going away ends its connection, and with it any attempt.
    started.once("exit", () => {
      if (this.#child !== started) return;
      this.#child = undefined;
      this.#token = undefined;
      this.#connection?.close();
    });
    this.#child = started;
    this.#token = token;
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
  return spawn(command, [...args], { stdio: ["pipe", "ignore", "pipe"] });
}

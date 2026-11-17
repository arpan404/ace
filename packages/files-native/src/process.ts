import {
  FilesRequestError,
  type FilesLog,
  type FilesRequestOptions,
  type FilesResult,
  type FilesState,
} from "./errors.ts";
import type { FilesChild, FilesClock, FilesHost } from "./host.ts";
import { Operations, type FilesSearchOptions, type FilesWatch } from "./operations.ts";
import { PendingRequests } from "./requests.ts";
import type { EventPayload, Op, SearchQuery, Summary } from "./schemas.ts";
import { restartDelay, supervisionTimings } from "./supervision.ts";
import { FrameDecoder, encodeMessage, FilesWireError, type FilesFrame } from "./wire.ts";

export type { FilesSearchOptions, FilesWatch } from "./operations.ts";

export type FilesProcessOptions = {
  binary: string;
  host: FilesHost;
  clock: FilesClock;
  /** Per-request timeout; the plan's default is 30 s. */
  timeoutMs?: number | undefined;
  log?: FilesLog | undefined;
};

type Run = {
  child: FilesChild;
  decoder: FrameDecoder;
  handshaken: boolean;
  dead: boolean;
  readyAt: number | undefined;
  version: string | undefined;
  stopHelloTimer: () => void;
};

/**
 * The daemon's owner of the ace-files process: start on demand, the `hello` handshake, restart
 * with backoff when it exits, per-request timeouts and cancellation, and re-opening the roots
 * and watches callers already hold after a restart. Calls keep their root and subscription
 * numbers across a restart; the operations book translates them.
 */
export class FilesProcess {
  readonly #host: FilesHost;
  readonly #clock: FilesClock;
  readonly #binary: string;
  readonly #timeoutMs: number;
  readonly #log: FilesLog | undefined;
  readonly #requests: PendingRequests;
  readonly #operations: Operations;
  readonly #waiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  #run: Run | undefined;
  #state: FilesState = "idle";
  #attempt = 0;
  #restartTimer: (() => void) | undefined;
  #disposed = false;

  constructor(options: FilesProcessOptions) {
    this.#host = options.host;
    this.#clock = options.clock;
    this.#binary = options.binary;
    this.#timeoutMs = options.timeoutMs ?? supervisionTimings.requestTimeoutMs;
    this.#log = options.log;
    this.#requests = new PendingRequests(options.clock, (bytes) => this.#write(bytes));
    this.#operations = new Operations({
      send: (op, timeoutMs) => this.#requests.send(op, timeoutMs),
      state: () => this.#state,
    });
  }

  /** Start ace-files unless it is already running, and resolve once the handshake is done. */
  start(): Promise<void> {
    if (this.#disposed)
      return Promise.reject(new FilesRequestError("CANCELLED", "ace-files was disposed"));
    if (this.#state === "up") return Promise.resolve();
    const ready = new Promise<void>((resolve, reject) => this.#waiters.push({ resolve, reject }));
    if (!this.#run && !this.#restartTimer) this.#spawn();
    return ready;
  }

  state(): FilesState {
    return this.#state;
  }

  get pid(): number | undefined {
    return this.#run?.child.pid;
  }

  get version(): string | undefined {
    return this.#run?.version;
  }

  /**
   * Send any op through the current process. Root numbers are the ones `openRoot` handed out.
   * Open roots, watches and searches through their methods, which keep them across restarts.
   */
  async request(op: Op, options: FilesRequestOptions = {}): Promise<FilesResult> {
    if (this.#state !== "up") throw restarting();
    return this.#requests.send(
      this.#operations.translate(op),
      options.timeoutMs ?? this.#timeoutMs,
      {
        body: options.body,
        signal: options.signal,
      },
    );
  }

  /** Open a checkout and return the number every later op on it uses. */
  openRoot(path: string): Promise<number> {
    return this.#operations.openRoot(path, this.#timeoutMs);
  }

  /** Forget a root. Its watches are dropped with it. */
  closeRoot(root: number): Promise<void> {
    return this.#operations.closeRoot(root, this.#timeoutMs);
  }

  /** Watch a root; every batch, rescan and warning goes to `onBatch`, across restarts. */
  watch(root: number, onBatch: (payload: EventPayload) => void): Promise<FilesWatch> {
    return this.#operations.watch(root, onBatch, this.#timeoutMs);
  }

  /** Search file contents, streaming matches, and resolve with the summary when it finishes. */
  search(root: number, query: SearchQuery, options: FilesSearchOptions): Promise<Summary> {
    return this.#operations.search(root, query, options, this.#timeoutMs);
  }

  /** Kill ace-files and never restart it. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#restartTimer?.();
    this.#restartTimer = undefined;
    const run = this.#run;
    if (run) {
      run.dead = true;
      run.stopHelloTimer();
      try {
        run.child.kill();
      } catch {
        // The process is already gone.
      }
    }
    this.#state = "disposed";
    const error = new FilesRequestError("CANCELLED", "ace-files was disposed");
    this.#requests.failAll(error);
    this.#operations.failAll(error);
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  #spawn(): void {
    if (this.#disposed || this.#run) return;
    this.#restartTimer = undefined;
    let child: FilesChild;
    try {
      child = this.#host.spawn(this.#binary);
    } catch (error) {
      this.#log?.("error", "ace-files failed to start", { error: String(error) });
      this.#afterExit(undefined, { code: null, signal: null });
      return;
    }
    const run: Run = {
      child,
      decoder: new FrameDecoder(),
      handshaken: false,
      dead: false,
      readyAt: undefined,
      version: undefined,
      stopHelloTimer: () => {},
    };
    this.#run = run;
    this.#state = "starting";
    child.stdout.onData((chunk) => this.#onData(run, chunk));
    child.stderr.onData((chunk) => {
      const text = new TextDecoder().decode(chunk).trim();
      if (text) this.#log?.("debug", `ace-files: ${text}`);
    });
    void child.exited.then((exit) => this.#onExit(run, exit));
    run.stopHelloTimer = this.#clock.setTimeout(() => {
      if (run.dead || run.handshaken) return;
      this.#log?.("error", "ace-files did not answer hello");
      this.#kill(run, "hello timeout");
    }, supervisionTimings.helloMs);
    this.#write(encodeMessage({ type: "hello", protocol: 1 }));
  }

  #onData(run: Run, chunk: Uint8Array): void {
    if (run !== this.#run || run.dead) return;
    run.decoder.push(chunk);
    for (;;) {
      let frame: FilesFrame | undefined;
      try {
        frame = run.decoder.poll();
      } catch (error) {
        if (error instanceof FilesWireError && error.code === "TOO_LARGE") {
          this.#log?.("error", "ace-files sent an oversize frame", { error: error.message });
          this.#kill(run, "oversize frame");
          return;
        }
        this.#log?.("warn", "ace-files sent an invalid frame", { error: String(error) });
        continue;
      }
      if (!frame) break;
      this.#onFrame(run, frame);
      if (run.dead || run !== this.#run) return;
    }
  }

  #onFrame(run: Run, frame: FilesFrame): void {
    if (run !== this.#run || run.dead) return;
    if (frame.kind === "body") {
      this.#requests.acceptBody(frame.id, frame.bytes);
      return;
    }
    const message = frame.message;
    switch (message.type) {
      case "hello":
        if (run.handshaken) {
          this.#log?.("error", "ace-files sent a second hello");
          this.#kill(run, "protocol");
          return;
        }
        if (message.protocol !== 1) {
          this.#log?.("error", "ace-files speaks another protocol", {
            protocol: message.protocol,
          });
          this.#kill(run, "protocol");
          return;
        }
        run.handshaken = true;
        run.readyAt = this.#clock.now();
        run.version = message.version;
        run.stopHelloTimer();
        void this.#restore(run);
        return;
      case "response":
        this.#requests.acceptResponse(message.id, message.result);
        return;
      case "error":
        this.#requests.acceptError(message.id, message.code, message.message, message.current);
        return;
      case "event":
        this.#operations.dispatch(message.subscription, message.payload, (text, fields) =>
          this.#log?.("error", text, fields),
        );
        return;
      default:
        this.#log?.("warn", "ace-files sent a message the daemon never sends", {
          type: message.type,
        });
    }
  }

  /** A run that cannot re-open the callers' roots is killed, never left half restored. */
  async #restore(run: Run): Promise<void> {
    try {
      await this.#operations.restore(this.#timeoutMs);
    } catch (error) {
      if (run !== this.#run || run.dead) return;
      this.#log?.("error", "ace-files could not re-open its roots", { error: String(error) });
      this.#kill(run, "restore failed");
      return;
    }
    if (run !== this.#run || run.dead) return;
    this.#state = "up";
    for (const waiter of this.#waiters.splice(0)) waiter.resolve();
    this.#log?.("info", "ace-files is ready", { pid: run.child.pid, version: run.version });
  }

  #onExit(run: Run, exit: { code: number | null; signal: string | null }): void {
    if (run !== this.#run) return;
    this.#run = undefined;
    run.dead = true;
    run.stopHelloTimer();
    this.#log?.("warn", "ace-files exited", { code: exit.code, signal: exit.signal });
    this.#afterExit(run, exit);
  }

  #afterExit(run: Run | undefined, exit: { code: number | null; signal: string | null }): void {
    const restartingError = restarting();
    this.#requests.failAll(restartingError);
    this.#operations.failAll(restartingError);
    if (this.#disposed) {
      this.#state = "disposed";
      for (const waiter of this.#waiters.splice(0)) waiter.reject(restartingError);
      return;
    }
    this.#state = "down";
    const now = this.#clock.now();
    if (run?.readyAt !== undefined && now - run.readyAt >= supervisionTimings.healthyResetMs)
      this.#attempt = 0;
    this.#attempt++;
    const delay = restartDelay(this.#attempt);
    this.#log?.("info", "ace-files will restart", { delayMs: delay, exit });
    this.#restartTimer = this.#clock.setTimeout(() => {
      this.#restartTimer = undefined;
      if (!this.#disposed) this.#spawn();
    }, delay);
  }

  #kill(run: Run, cause: string): void {
    if (run.dead) return;
    run.dead = true;
    run.stopHelloTimer();
    this.#log?.("warn", "killing ace-files", { cause });
    try {
      run.child.kill();
    } catch {
      // Already gone; the exit promise settles the run.
    }
  }

  #write(bytes: Uint8Array): void {
    const run = this.#run;
    if (!run || run.dead) return;
    try {
      run.child.stdin.write(bytes);
    } catch (error) {
      this.#log?.("warn", "ace-files stdin is closed", { error: String(error) });
    }
  }
}

function restarting(): FilesRequestError {
  return new FilesRequestError("FILES_RESTARTING", "ace-files is restarting");
}

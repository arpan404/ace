import {
  FilesRequestError,
  type FilesLog,
  type FilesRequestOptions,
  type FilesResult,
  type FilesState,
} from "./errors.ts";
import type { FilesChild, FilesClock, FilesHost } from "./host.ts";
import { PendingRequests } from "./requests.ts";
import type { EventPayload, FileMatches, Op, Reply, SearchQuery, Summary } from "./schemas.ts";
import { restartDelay, supervisionTimings } from "./supervision.ts";
import { FrameDecoder, encodeMessage, FilesWireError, type FilesFrame } from "./wire.ts";

/** An open watch. Dispose it, or `await using` it, to tell ace-files to stop. */
export type FilesWatch = {
  readonly subscription: number;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

/** A running search's callbacks. */
export type FilesSearchOptions = {
  onMatches: (file: FileMatches) => void;
  signal?: AbortSignal | undefined;
};

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

type RootEntry = { path: string; binary: number | undefined };
type WatchEntry = {
  root: number;
  binary: number | undefined;
  onBatch: (payload: EventPayload) => void;
};
type SearchEntry = {
  onMatches: (file: FileMatches) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  resolve: (summary: Summary) => void;
  reject: (error: Error) => void;
};

/**
 * The daemon's owner of the ace-files process: start on demand, the `hello` handshake, restart
 * with backoff when it exits, per-request timeouts and cancellation, and re-opening the roots
 * and watches callers already hold after a restart. Calls keep their root and subscription
 * numbers across a restart; the process translates them.
 */
export class FilesProcess {
  readonly #host: FilesHost;
  readonly #clock: FilesClock;
  readonly #binary: string;
  readonly #timeoutMs: number;
  readonly #log: FilesLog | undefined;
  readonly #requests: PendingRequests;
  readonly #roots = new Map<number, RootEntry>();
  readonly #watches = new Map<number, WatchEntry>();
  readonly #searches = new Map<number, SearchEntry>();
  readonly #waiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  #run: Run | undefined;
  #state: FilesState = "idle";
  #attempt = 0;
  #restartTimer: (() => void) | undefined;
  #disposed = false;
  #nextRoot = 1;
  #nextSubscription = 1;

  constructor(options: FilesProcessOptions) {
    this.#host = options.host;
    this.#clock = options.clock;
    this.#binary = options.binary;
    this.#timeoutMs = options.timeoutMs ?? supervisionTimings.requestTimeoutMs;
    this.#log = options.log;
    this.#requests = new PendingRequests(options.clock, (bytes) => this.#write(bytes));
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

  /** Send any op. Root numbers are the ones `openRoot` handed out. */
  async request(op: Op, options: FilesRequestOptions = {}): Promise<FilesResult> {
    if (this.#state !== "up") throw restarting();
    return this.#requests.send(this.#translate(op), options.timeoutMs ?? this.#timeoutMs, {
      body: options.body,
      signal: options.signal,
    });
  }

  /** Open a checkout and return the number every later op on it uses. */
  async openRoot(path: string): Promise<number> {
    if (this.#state !== "up") throw restarting();
    const { reply } = await this.#requests.send({ op: "openRoot", path }, this.#timeoutMs);
    if (reply.type !== "root") throw unexpected("openRoot", reply);
    const root = this.#nextRoot++;
    this.#roots.set(root, { path, binary: reply.root });
    return root;
  }

  /** Forget a root. Its watches are dropped with it. */
  async closeRoot(root: number): Promise<void> {
    if (this.#state !== "up") throw restarting();
    const entry = this.#roots.get(root);
    if (!entry || entry.binary === undefined)
      throw new FilesRequestError("INVALID_ARGUMENT", `root ${root} is not open`);
    const { reply } = await this.#requests.send(
      { op: "closeRoot", root: entry.binary },
      this.#timeoutMs,
    );
    if (reply.type !== "done") throw unexpected("closeRoot", reply);
    this.#roots.delete(root);
    for (const [subscription, watch] of this.#watches)
      if (watch.root === root) this.#watches.delete(subscription);
  }

  /** Watch a root; every batch, rescan and warning goes to `onBatch`, across restarts. */
  async watch(root: number, onBatch: (payload: EventPayload) => void): Promise<FilesWatch> {
    if (this.#state !== "up") throw restarting();
    const { reply } = await this.#requests.send(
      { op: "watch", root: this.#binaryRoot(root) },
      this.#timeoutMs,
    );
    if (reply.type !== "subscription") throw unexpected("watch", reply);
    const subscription = this.#nextSubscription++;
    this.#watches.set(subscription, { root, binary: reply.subscription, onBatch });
    let closed = false;
    const dispose = async () => {
      if (closed) return;
      closed = true;
      await this.#unwatch(subscription);
    };
    return { subscription, dispose, [Symbol.asyncDispose]: dispose };
  }

  /** Search file contents, streaming matches, and resolve with the summary when it finishes. */
  search(root: number, query: SearchQuery, options: FilesSearchOptions): Promise<Summary> {
    return this.#startSearch(root, query, options);
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
    for (const subscription of Array.from(this.#searches.keys())) {
      const search = this.#searches.get(subscription);
      this.#removeSearch(subscription);
      search?.reject(error);
    }
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  async #startSearch(
    root: number,
    query: SearchQuery,
    options: FilesSearchOptions,
  ): Promise<Summary> {
    if (this.#state !== "up") throw restarting();
    const { reply } = await this.#requests.send(
      { op: "search", root: this.#binaryRoot(root), ...query },
      this.#timeoutMs,
      { signal: options.signal },
    );
    if (reply.type !== "subscription") throw unexpected("search", reply);
    const subscription = reply.subscription;
    return new Promise<Summary>((resolve, reject) => {
      const search: SearchEntry = {
        onMatches: options.onMatches,
        signal: options.signal,
        onAbort: undefined,
        resolve,
        reject,
      };
      if (options.signal) {
        if (options.signal.aborted) {
          reject(new FilesRequestError("CANCELLED", "the search was cancelled"));
          void this.#stopSearch(subscription);
          return;
        }
        search.onAbort = () => {
          this.#removeSearch(subscription);
          reject(new FilesRequestError("CANCELLED", "the search was cancelled"));
          void this.#stopSearch(subscription);
        };
        options.signal.addEventListener("abort", search.onAbort, { once: true });
      }
      this.#searches.set(subscription, search);
    });
  }

  async #stopSearch(subscription: number): Promise<void> {
    if (this.#state !== "up") return;
    try {
      await this.#requests.send({ op: "unwatch", subscription }, this.#timeoutMs);
    } catch (error) {
      this.#log?.("warn", "ace-files could not close a search", { error: String(error) });
    }
  }

  async #unwatch(subscription: number): Promise<void> {
    const watch = this.#watches.get(subscription);
    if (!watch) return;
    this.#watches.delete(subscription);
    if (watch.binary === undefined || this.#state !== "up") return;
    try {
      await this.#requests.send({ op: "unwatch", subscription: watch.binary }, this.#timeoutMs);
    } catch (error) {
      this.#log?.("warn", "ace-files could not close a watch", { error: String(error) });
    }
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
        this.#dispatch(message.subscription, message.payload);
        return;
      default:
        this.#log?.("warn", "ace-files sent a message the daemon never sends", {
          type: message.type,
        });
    }
  }

  /**
   * Re-open the roots and watches callers hold, and only then accept requests again. A run that
   * cannot re-open them is killed, so a half-restored process never answers half the view.
   */
  async #restore(run: Run): Promise<void> {
    try {
      for (const root of this.#roots.values()) {
        const { reply } = await this.#requests.send(
          { op: "openRoot", path: root.path },
          this.#timeoutMs,
        );
        if (reply.type !== "root") throw unexpected("openRoot", reply);
        root.binary = reply.root;
      }
      for (const watch of this.#watches.values()) {
        const root = this.#roots.get(watch.root);
        if (!root || root.binary === undefined) continue;
        const { reply } = await this.#requests.send(
          { op: "watch", root: root.binary },
          this.#timeoutMs,
        );
        if (reply.type !== "subscription") throw unexpected("watch", reply);
        watch.binary = reply.subscription;
      }
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

  #dispatch(subscription: number, payload: EventPayload): void {
    for (const watch of this.#watches.values()) {
      if (watch.binary !== subscription) continue;
      try {
        watch.onBatch(payload);
      } catch (error) {
        this.#log?.("error", "a watch listener failed", { error: String(error) });
      }
      return;
    }
    const search = this.#searches.get(subscription);
    if (!search) return;
    if (payload.type === "matches") {
      try {
        search.onMatches(payload.file);
      } catch (error) {
        this.#log?.("error", "a search listener failed", { error: String(error) });
      }
      return;
    }
    if (payload.type === "searchDone") {
      this.#removeSearch(subscription);
      search.resolve(payload.summary);
    }
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
    for (const subscription of Array.from(this.#searches.keys())) {
      const search = this.#searches.get(subscription);
      this.#removeSearch(subscription);
      search?.reject(restartingError);
    }
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

  #translate(op: Op): Op {
    switch (op.op) {
      case "openRoot":
      case "closeRoot":
      case "unwatch":
        return op;
      default:
        return { ...op, root: this.#binaryRoot(op.root) };
    }
  }

  #binaryRoot(root: number): number {
    const entry = this.#roots.get(root);
    if (!entry || entry.binary === undefined)
      throw new FilesRequestError("INVALID_ARGUMENT", `root ${root} is not open`);
    return entry.binary;
  }

  #removeSearch(subscription: number): void {
    const search = this.#searches.get(subscription);
    if (!search) return;
    this.#searches.delete(subscription);
    if (search.signal && search.onAbort) search.signal.removeEventListener("abort", search.onAbort);
  }
}

function restarting(): FilesRequestError {
  return new FilesRequestError("FILES_RESTARTING", "ace-files is restarting");
}

function unexpected(op: string, reply: Reply): FilesRequestError {
  return new FilesRequestError("INVALID_ARGUMENT", `ace-files answered ${op} with ${reply.type}`);
}

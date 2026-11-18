import { FilesRequestError, type FilesResult, type FilesState } from "./errors.ts";
import type { EventPayload, FileMatches, Op, SearchQuery, Summary } from "./schemas.ts";
import { SearchBook, type SearchEntry } from "./search-book.ts";

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

/** What the book needs from the process: a live run and a way to write a request on it. */
export type OperationsPorts = {
  send(
    op: Op,
    timeoutMs: number,
    options?: {
      signal?: AbortSignal | undefined;
      onReply?: ((reply: FilesResult["reply"]) => void) | undefined;
    },
  ): Promise<FilesResult>;
  state(): FilesState;
};

type RootEntry = {
  path: string;
  binary: number | undefined;
  /** The error the binary gave when this root could not be re-opened after a restart. */
  error: FilesRequestError | undefined;
};
type WatchEntry = {
  root: number;
  binary: number | undefined;
  onBatch: (payload: EventPayload) => void;
};
/** Codes that mean the run itself is in trouble, not one root or one subscription. */
const transportCodes = new Set(["FILES_RESTARTING", "TIMEOUT", "CANCELLED", "BUSY", "PROTOCOL"]);

/**
 * What the daemon already asked ace-files to keep open: roots, watches and running searches.
 * Callers see stable numbers here; after a restart the book re-opens them on the new process and
 * translates the numbers, so nothing above has to know a restart happened.
 *
 * A watch or search is registered synchronously from the response frame, not after the
 * awaiting caller resumes, because ace-files may put an event in the same stdout chunk.
 */
export class Operations {
  readonly #ports: OperationsPorts;
  readonly #roots = new Map<number, RootEntry>();
  readonly #watches = new Map<number, WatchEntry>();
  readonly #watchesByBinary = new Map<number, number>();
  readonly #searches = new SearchBook();
  #nextRoot = 1;
  #nextSubscription = 1;

  constructor(ports: OperationsPorts) {
    this.#ports = ports;
  }

  /** Translate a caller's op onto the current process's root numbers. */
  translate(op: Op): Op {
    switch (op.op) {
      case "openRoot":
      case "closeRoot":
      case "unwatch":
        return op;
      default:
        return { ...op, root: this.#binaryRoot(op.root) };
    }
  }

  async openRoot(path: string, timeoutMs: number): Promise<number> {
    this.#requireUp();
    const { reply } = await this.#ports.send({ op: "openRoot", path }, timeoutMs);
    if (reply.type !== "root") throw protocol("openRoot", reply);
    const root = this.#nextRoot++;
    this.#roots.set(root, { path, binary: reply.root, error: undefined });
    return root;
  }

  async closeRoot(root: number, timeoutMs: number): Promise<void> {
    this.#requireUp();
    const entry = this.#roots.get(root);
    if (!entry) throw new FilesRequestError("INVALID_ARGUMENT", `root ${root} is not open`);
    if (entry.binary !== undefined) {
      const { reply } = await this.#ports.send({ op: "closeRoot", root: entry.binary }, timeoutMs);
      if (reply.type !== "done") throw protocol("closeRoot", reply);
    }
    this.#roots.delete(root);
    for (const subscription of Array.from(this.#watches.keys())) {
      const watch = this.#watches.get(subscription);
      if (watch?.root === root) this.#dropWatch(subscription);
    }
  }

  async watch(
    root: number,
    onBatch: (payload: EventPayload) => void,
    timeoutMs: number,
  ): Promise<FilesWatch> {
    this.#requireUp();
    const subscription = this.#nextSubscription++;
    try {
      const { reply } = await this.#ports.send(
        { op: "watch", root: this.#binaryRoot(root) },
        timeoutMs,
        {
          onReply: (answer) => {
            if (answer.type !== "subscription") return;
            const entry = { root, binary: answer.subscription, onBatch };
            this.#watches.set(subscription, entry);
            this.#watchesByBinary.set(answer.subscription, subscription);
          },
        },
      );
      if (reply.type !== "subscription") throw protocol("watch", reply);
    } catch (error) {
      this.#dropWatch(subscription);
      throw error;
    }
    let closed = false;
    const dispose = async () => {
      if (closed) return;
      closed = true;
      await this.unwatch(subscription, timeoutMs);
    };
    return { subscription, dispose, [Symbol.asyncDispose]: dispose };
  }

  async search(
    root: number,
    query: SearchQuery,
    options: FilesSearchOptions,
    timeoutMs: number,
  ): Promise<Summary> {
    this.#requireUp();
    let resolveSummary!: (summary: Summary) => void;
    let rejectSummary!: (error: Error) => void;
    const completion = new Promise<Summary>((resolve, reject) => {
      resolveSummary = resolve;
      rejectSummary = reject;
    });
    try {
      const { reply } = await this.#ports.send(
        { op: "search", root: this.#binaryRoot(root), ...query },
        timeoutMs,
        {
          signal: options.signal,
          onReply: (answer) => {
            if (answer.type !== "subscription") return;
            const subscription = answer.subscription;
            const search: SearchEntry = {
              onMatches: options.onMatches,
              signal: options.signal,
              onAbort: undefined,
              resolve: resolveSummary,
              reject: rejectSummary,
            };
            if (options.signal) {
              search.onAbort = () => {
                this.#searches.remove(subscription);
                rejectSummary(new FilesRequestError("CANCELLED", "the search was cancelled"));
                void this.#stopSearch(subscription, timeoutMs);
              };
              options.signal.addEventListener("abort", search.onAbort, { once: true });
            }
            this.#searches.add(subscription, search);
          },
        },
      );
      if (reply.type !== "subscription") throw protocol("search", reply);
    } catch (error) {
      rejectSummary(error instanceof Error ? error : new Error(String(error)));
      return completion;
    }
    return completion;
  }

  /**
   * Re-open every root and watch on a fresh process. One root the binary refuses (its folder
   * vanished, say) is marked unavailable and its watches get a warning; only a transport failure
   * escapes, and the process then kills the run.
   */
  async restore(timeoutMs: number): Promise<void> {
    for (const [rootNumber, root] of Array.from(this.#roots)) {
      if (!this.#roots.has(rootNumber)) continue;
      let failure: FilesRequestError | undefined;
      try {
        const { reply } = await this.#ports.send({ op: "openRoot", path: root.path }, timeoutMs, {
          onReply: (answer) => {
            if (answer.type === "root") root.binary = answer.root;
          },
        });
        if (reply.type !== "root") throw protocol("openRoot", reply);
        root.error = undefined;
      } catch (error) {
        if (isTransport(error)) throw error;
        failure = asRequestError(error);
        root.binary = undefined;
        root.error = failure;
      }
      if (!this.#roots.has(rootNumber)) {
        const binary = root.binary;
        root.binary = undefined;
        if (binary !== undefined) await this.#closeSilently(binary, timeoutMs);
        continue;
      }
      if (failure) this.#warnRoot(rootNumber, root, failure);
    }

    for (const [subscription, watch] of Array.from(this.#watches)) {
      if (!this.#watches.has(subscription)) continue;
      const root = this.#roots.get(watch.root);
      if (!root || root.binary === undefined) {
        this.#clearWatchBinary(subscription);
        continue;
      }
      let failure: FilesRequestError | undefined;
      let reopened: number | undefined;
      try {
        const { reply } = await this.#ports.send({ op: "watch", root: root.binary }, timeoutMs, {
          onReply: (answer) => {
            if (answer.type !== "subscription") return;
            reopened = answer.subscription;
            this.#setWatchBinary(subscription, answer.subscription);
          },
        });
        if (reply.type !== "subscription") throw protocol("watch", reply);
      } catch (error) {
        if (isTransport(error)) throw error;
        failure = asRequestError(error);
        this.#clearWatchBinary(subscription);
      }
      if (!this.#watches.has(subscription)) {
        // Disposed while the re-open was in flight: close the number the new run just handed out.
        watch.binary = undefined;
        if (reopened !== undefined) await this.#stopWatch(reopened, timeoutMs);
        continue;
      }
      if (failure) this.#warnWatch(subscription, watch, failure.message);
    }
  }

  /**
   * Route an event to the watch or search that owns the process's subscription number. The
   * reverse map makes this constant-time: a batch names one subscription, not the whole book.
   */
  dispatch(
    subscription: number,
    payload: EventPayload,
    log?: (message: string, fields: Record<string, unknown>) => void,
  ): void {
    const clientSubscription = this.#watchesByBinary.get(subscription);
    if (clientSubscription !== undefined) {
      const watch = this.#watches.get(clientSubscription);
      if (watch) {
        this.#deliver(watch, payload, log);
        return;
      }
      this.#watchesByBinary.delete(subscription);
    }
    this.#searches.dispatch(subscription, payload, log);
  }

  /** A process exit drops every number it handed out; books stay for the restart. */
  failAll(error: Error): void {
    for (const root of this.#roots.values()) root.binary = undefined;
    for (const subscription of Array.from(this.#watches.keys()))
      this.#clearWatchBinary(subscription);
    this.#watchesByBinary.clear();
    this.#searches.failAll(error);
  }

  async unwatch(subscription: number, timeoutMs: number): Promise<void> {
    const watch = this.#watches.get(subscription);
    if (!watch) return;
    const binary = watch.binary;
    this.#dropWatch(subscription);
    if (binary === undefined || this.#ports.state() !== "up") return;
    await this.#stopWatch(binary, timeoutMs);
  }

  async #stopWatch(binary: number, timeoutMs: number): Promise<void> {
    if (!this.#live()) return;
    try {
      await this.#ports.send({ op: "unwatch", subscription: binary }, timeoutMs);
    } catch {
      // The process may be gone; the watch is dropped either way.
    }
  }

  async #stopSearch(subscription: number, timeoutMs: number): Promise<void> {
    await this.#stopWatch(subscription, timeoutMs);
  }

  async #closeSilently(binary: number, timeoutMs: number): Promise<void> {
    if (!this.#live()) return;
    try {
      await this.#ports.send({ op: "closeRoot", root: binary }, timeoutMs);
    } catch {
      // The process may be gone; the root is closed either way.
    }
  }

  #setWatchBinary(subscription: number, binary: number): void {
    const watch = this.#watches.get(subscription);
    if (!watch) return;
    if (watch.binary !== undefined) this.#watchesByBinary.delete(watch.binary);
    watch.binary = binary;
    this.#watchesByBinary.set(binary, subscription);
  }

  #clearWatchBinary(subscription: number): void {
    const watch = this.#watches.get(subscription);
    if (!watch) return;
    if (watch.binary !== undefined) this.#watchesByBinary.delete(watch.binary);
    watch.binary = undefined;
  }

  #dropWatch(subscription: number): void {
    this.#clearWatchBinary(subscription);
    this.#watches.delete(subscription);
  }

  #warnRoot(rootNumber: number, root: RootEntry, error: FilesRequestError): void {
    for (const [subscription, watch] of this.#watches) {
      if (watch.root !== rootNumber) continue;
      this.#warnWatch(
        subscription,
        watch,
        `ace-files could not re-open ${root.path}: ${error.message}`,
      );
    }
  }

  #warnWatch(subscription: number, watch: WatchEntry, message: string): void {
    this.#deliver(watch, { type: "warning", message });
    this.#clearWatchBinary(subscription);
  }

  #deliver(
    watch: WatchEntry,
    payload: EventPayload,
    log?: (message: string, fields: Record<string, unknown>) => void,
  ): void {
    try {
      watch.onBatch(payload);
    } catch (error) {
      log?.("a watch listener failed", { error: String(error) });
    }
  }

  #binaryRoot(root: number): number {
    const entry = this.#roots.get(root);
    if (!entry) throw new FilesRequestError("INVALID_ARGUMENT", `root ${root} is not open`);
    if (entry.binary === undefined) {
      if (entry.error)
        throw new FilesRequestError(entry.error.code, entry.error.message, entry.error.current);
      throw restarting();
    }
    return entry.binary;
  }

  #requireUp(): void {
    if (this.#ports.state() !== "up") throw restarting();
  }

  /** True while a run is alive: the handshake is done and restore may still be closing books. */
  #live(): boolean {
    const state = this.#ports.state();
    return state === "up" || state === "starting";
  }
}

function restarting(): FilesRequestError {
  return new FilesRequestError("FILES_RESTARTING", "ace-files is restarting");
}

function protocol(op: string, reply: { type: string }): FilesRequestError {
  return new FilesRequestError("PROTOCOL", `ace-files answered ${op} with ${reply.type}`);
}

function asRequestError(error: unknown): FilesRequestError {
  if (error instanceof FilesRequestError) return error;
  return new FilesRequestError("IO_ERROR", error instanceof Error ? error.message : String(error));
}

function isTransport(error: unknown): boolean {
  return !(error instanceof FilesRequestError) || transportCodes.has(error.code);
}

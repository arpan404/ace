import { FilesRequestError, type FilesResult, type FilesState } from "./errors.ts";
import type { EventPayload, FileMatches, Op, SearchQuery, Summary } from "./schemas.ts";

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
  send(op: Op, timeoutMs: number): Promise<FilesResult>;
  state(): FilesState;
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
 * What the daemon already asked ace-files to keep open: roots, watches and running searches.
 * Callers see stable numbers here; after a restart the book re-opens them on the new process and
 * translates the numbers, so nothing above has to know a restart happened.
 */
export class Operations {
  readonly #ports: OperationsPorts;
  readonly #roots = new Map<number, RootEntry>();
  readonly #watches = new Map<number, WatchEntry>();
  readonly #searches = new Map<number, SearchEntry>();
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
    if (reply.type !== "root") throw unexpected("openRoot", reply);
    const root = this.#nextRoot++;
    this.#roots.set(root, { path, binary: reply.root });
    return root;
  }

  async closeRoot(root: number, timeoutMs: number): Promise<void> {
    this.#requireUp();
    const binary = this.#binaryRoot(root);
    const { reply } = await this.#ports.send({ op: "closeRoot", root: binary }, timeoutMs);
    if (reply.type !== "done") throw unexpected("closeRoot", reply);
    this.#roots.delete(root);
    for (const [subscription, watch] of this.#watches)
      if (watch.root === root) this.#watches.delete(subscription);
  }

  async watch(
    root: number,
    onBatch: (payload: EventPayload) => void,
    timeoutMs: number,
  ): Promise<FilesWatch> {
    this.#requireUp();
    const { reply } = await this.#ports.send(
      { op: "watch", root: this.#binaryRoot(root) },
      timeoutMs,
    );
    if (reply.type !== "subscription") throw unexpected("watch", reply);
    const subscription = this.#nextSubscription++;
    this.#watches.set(subscription, { root, binary: reply.subscription, onBatch });
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
    const { reply } = await this.#ports.send(
      { op: "search", root: this.#binaryRoot(root), ...query },
      timeoutMs,
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
          void this.#stopSearch(subscription, timeoutMs);
          return;
        }
        search.onAbort = () => {
          this.#removeSearch(subscription);
          reject(new FilesRequestError("CANCELLED", "the search was cancelled"));
          void this.#stopSearch(subscription, timeoutMs);
        };
        options.signal.addEventListener("abort", search.onAbort, { once: true });
      }
      this.#searches.set(subscription, search);
    });
  }

  /** Re-open every root and watch on a fresh process, then let requests through. */
  async restore(timeoutMs: number): Promise<void> {
    for (const root of this.#roots.values()) {
      const { reply } = await this.#ports.send({ op: "openRoot", path: root.path }, timeoutMs);
      if (reply.type !== "root") throw unexpected("openRoot", reply);
      root.binary = reply.root;
    }
    for (const watch of this.#watches.values()) {
      const root = this.#roots.get(watch.root);
      if (!root || root.binary === undefined) continue;
      const { reply } = await this.#ports.send({ op: "watch", root: root.binary }, timeoutMs);
      if (reply.type !== "subscription") throw unexpected("watch", reply);
      watch.binary = reply.subscription;
    }
  }

  /** Route an event to the watch or search that owns the process's subscription number. */
  dispatch(
    subscription: number,
    payload: EventPayload,
    log?: (message: string, fields: Record<string, unknown>) => void,
  ): void {
    for (const watch of this.#watches.values()) {
      if (watch.binary !== subscription) continue;
      try {
        watch.onBatch(payload);
      } catch (error) {
        log?.("a watch listener failed", { error: String(error) });
      }
      return;
    }
    const search = this.#searches.get(subscription);
    if (!search) return;
    if (payload.type === "matches") {
      try {
        search.onMatches(payload.file);
      } catch (error) {
        log?.("a search listener failed", { error: String(error) });
      }
      return;
    }
    if (payload.type === "searchDone") {
      this.#removeSearch(subscription);
      search.resolve(payload.summary);
    }
  }

  /** A process exit fails every search; watches and roots stay registered for the restart. */
  failAll(error: Error): void {
    for (const subscription of Array.from(this.#searches.keys())) {
      const search = this.#searches.get(subscription);
      this.#removeSearch(subscription);
      search?.reject(error);
    }
  }

  async unwatch(subscription: number, timeoutMs: number): Promise<void> {
    const watch = this.#watches.get(subscription);
    if (!watch) return;
    this.#watches.delete(subscription);
    if (watch.binary === undefined || this.#ports.state() !== "up") return;
    try {
      await this.#ports.send({ op: "unwatch", subscription: watch.binary }, timeoutMs);
    } catch {
      // The process may be gone; the watch is dropped either way.
    }
  }

  async #stopSearch(subscription: number, timeoutMs: number): Promise<void> {
    if (this.#ports.state() !== "up") return;
    try {
      await this.#ports.send({ op: "unwatch", subscription }, timeoutMs);
    } catch {
      // The process may be gone; the search is dropped either way.
    }
  }

  #binaryRoot(root: number): number {
    const entry = this.#roots.get(root);
    if (!entry || entry.binary === undefined)
      throw new FilesRequestError("INVALID_ARGUMENT", `root ${root} is not open`);
    return entry.binary;
  }

  #requireUp(): void {
    if (this.#ports.state() !== "up") throw restarting();
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

function unexpected(op: string, reply: { type: string }): FilesRequestError {
  return new FilesRequestError("INVALID_ARGUMENT", `ace-files answered ${op} with ${reply.type}`);
}

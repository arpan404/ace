import { SearchQuery, type SearchResults } from "@ace/protocol";
import { SearchWorkerResult } from "./worker-protocol.ts";
import {
  spawnSearchWorker,
  type SearchWorker,
  type SearchWorkerFactory,
} from "./worker-runtime.ts";

/** One reader with bounded admission. Ranking cannot block the daemon's event loop. */
class SearchReader {
  private readonly path: string;
  private readonly createWorker: SearchWorkerFactory;
  private worker: SearchWorker | undefined;
  private nextId = 0;
  private closed = false;
  private retiring = false;
  private cleanupFailed = false;
  private stopping: Promise<void> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private pending = new Map<
    number,
    { resolve: (results: SearchResults) => void; reject: (error: Error) => void }
  >();
  constructor(path: string, createWorker: SearchWorkerFactory) {
    this.path = path;
    this.createWorker = createWorker;
  }
  query(input: unknown): Promise<SearchResults> {
    const parsed = SearchQuery.safeParse(input);
    if (!parsed.success) return Promise.reject(new Error("search_invalid_query"));
    if (this.closed || this.retiring || this.cleanupFailed || this.pending.size >= 16)
      return Promise.reject(new Error("search_failed"));
    if (!this.worker) {
      try {
        const worker = this.createWorker(this.path);
        this.worker = worker;
        worker.on("message", (response: unknown) => {
          if (this.worker !== worker) return;
          const decoded = SearchWorkerResult.safeParse(response);
          if (!decoded.success) {
            this.stopWorker();
            return;
          }
          const result = decoded.data;
          const request = this.pending.get(result.id);
          this.pending.delete(result.id);
          if (result.ok) request?.resolve(result.results);
          else request?.reject(new Error(result.error));
          if (!this.pending.size && this.path !== ":memory:") worker.idle?.();
        });
        worker.on("error", () => {
          if (this.worker === worker) this.stopWorker();
        });
        worker.on("exit", () => {
          if (this.worker === worker) {
            this.worker = undefined;
            this.fail();
          }
        });
      } catch {
        this.stopWorker();
        return Promise.reject(new Error("search_failed"));
      }
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker?.postMessage({ id, query: parsed.data });
      } catch {
        this.pending.delete(id);
        reject(new Error("search_failed"));
        this.stopWorker();
      }
    });
  }
  private fail(): void {
    for (const request of this.pending.values()) request.reject(new Error("search_failed"));
    this.pending.clear();
  }
  private stopWorker(): void {
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    this.fail();
    this.retiring = true;
    const stopped = Promise.withResolvers<void>();
    this.stopping = stopped.promise;
    try {
      void worker.terminate().then(
        () => {
          this.retiring = false;
          stopped.resolve();
        },
        () => {
          this.retiring = false;
          this.cleanupFailed = true;
          stopped.resolve();
        },
      );
    } catch {
      this.retiring = false;
      this.cleanupFailed = true;
      stopped.resolve();
    }
  }
  close(): Promise<void> {
    if (!this.closing) {
      const finished = Promise.withResolvers<void>();
      this.closing = finished.promise;
      this.closed = true;
      this.fail();
      this.stopWorker();
      void this.stopping.then(() => {
        if (this.cleanupFailed) finished.reject(new Error("search_failed"));
        else finished.resolve();
      }, finished.reject);
    }
    return this.closing;
  }
}

/** Title requests have independent admission and execution from transcript ranking. */
export class SearchQueries {
  private readonly transcripts: SearchReader;
  private readonly titles: SearchReader;
  private closing: Promise<void> | undefined;
  constructor(path: string, createWorker: SearchWorkerFactory = spawnSearchWorker) {
    this.transcripts = new SearchReader(path, createWorker);
    this.titles = new SearchReader(path, createWorker);
  }
  query(input: unknown): Promise<SearchResults> {
    const parsed = SearchQuery.safeParse(input);
    if (!parsed.success) return Promise.reject(new Error("search_invalid_query"));
    const reader = parsed.data.scope === "threads" ? this.titles : this.transcripts;
    return reader.query(parsed.data);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const finished = Promise.withResolvers<void>();
    this.closing = finished.promise;
    void Promise.allSettled([this.transcripts.close(), this.titles.close()]).then((results) => {
      if (results.some((result) => result.status === "rejected"))
        finished.reject(new Error("search_failed"));
      else finished.resolve();
    }, finished.reject);
    return this.closing;
  }
}

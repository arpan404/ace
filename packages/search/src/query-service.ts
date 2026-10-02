import { Worker } from "node:worker_threads";
import { SearchQuery, type SearchResults } from "@ace/protocol";
import { SearchWorkerResult } from "./worker-protocol.ts";

/** One reader with bounded admission. Ranking cannot block the daemon's event loop. */
class SearchReader {
  private readonly path: string;
  private worker: Worker | undefined;
  private nextId = 0;
  private closed = false;
  private pending = new Map<
    number,
    { resolve: (results: SearchResults) => void; reject: (error: Error) => void }
  >();
  constructor(path: string) {
    this.path = path;
  }
  query(input: unknown): Promise<SearchResults> {
    const parsed = SearchQuery.safeParse(input);
    if (!parsed.success) return Promise.reject(new Error("search_invalid_query"));
    if (this.closed || this.pending.size >= 16) return Promise.reject(new Error("search_failed"));
    if (!this.worker) {
      const worker = new Worker(new URL("./query-worker.ts", import.meta.url), {
        workerData: { path: this.path },
      });
      this.worker = worker;
      worker.on("message", (response: unknown) => {
        const decoded = SearchWorkerResult.safeParse(response);
        if (!decoded.success) {
          this.fail();
          void worker.terminate();
          return;
        }
        const result = decoded.data;
        const request = this.pending.get(result.id);
        this.pending.delete(result.id);
        if (result.ok) request?.resolve(result.results);
        else request?.reject(new Error(result.error));
      });
      worker.on("error", () => this.fail());
      worker.on("exit", () => {
        if (this.worker === worker) {
          this.worker = undefined;
          this.fail();
        }
      });
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker?.postMessage({ id, query: parsed.data });
      } catch {
        this.pending.delete(id);
        reject(new Error("search_failed"));
      }
    });
  }
  private fail(): void {
    for (const request of this.pending.values()) request.reject(new Error("search_failed"));
    this.pending.clear();
  }
  close(): void {
    this.closed = true;
    this.fail();
    void this.worker?.terminate();
    this.worker = undefined;
  }
}

/** Title requests have independent admission and execution from transcript ranking. */
export class SearchQueries {
  private readonly transcripts: SearchReader;
  private readonly titles: SearchReader;
  constructor(path: string) {
    this.transcripts = new SearchReader(path);
    this.titles = new SearchReader(path);
  }
  query(input: unknown): Promise<SearchResults> {
    const parsed = SearchQuery.safeParse(input);
    if (!parsed.success) return Promise.reject(new Error("search_invalid_query"));
    const reader = parsed.data.scope === "threads" ? this.titles : this.transcripts;
    return reader.query(parsed.data);
  }
  close(): void {
    this.transcripts.close();
    this.titles.close();
  }
}

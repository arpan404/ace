// MessagePort.postMessage has no browser targetOrigin argument.
/* eslint-disable unicorn/require-post-message-target-origin */
import { workerResponse } from "./rg-parser.ts";
import type { Worker } from "node:worker_threads";
import type { WorkspaceRuntime } from "./runtime.ts";
import { aborted, WorkspaceError, type Match } from "./types.ts";

/** Regex work runs off the daemon thread so cancellation can terminate it. */
export class NodeSearch {
  private readonly worker: Worker;
  private readonly runtime: WorkspaceRuntime;
  private problem: Error | undefined;
  constructor(runtime: WorkspaceRuntime) {
    this.runtime = runtime;
    this.worker = runtime.createWorker(new URL("./node-search-worker.ts", import.meta.url));
    // The worker can fail during filesystem traversal, before match attaches listeners.
    this.worker.on("error", (error: Error) => {
      this.problem = error;
    });
    this.worker.on("exit", () => {
      this.problem ??= new Error("Search worker exited");
    });
  }
  async match(
    request: { text: string; path: string; source: string; caseSensitive: boolean; limit: number },
    signal?: AbortSignal,
  ): Promise<Match[]> {
    aborted(signal);
    if (this.problem) throw new WorkspaceError("SEARCH_FAILED", this.problem.message, this.problem);
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, matches?: Match[]) => {
        deadline();
        signal?.removeEventListener("abort", cancel);
        this.worker.off("message", message);
        this.worker.off("error", failed);
        this.worker.off("exit", exited);
        if (error) reject(error);
        else resolve(matches ?? []);
      };
      const cancel = () => {
        void this.worker.terminate();
        finish(new WorkspaceError("ABORTED", "Search cancelled"));
      };
      const failed = (error: Error) =>
        finish(new WorkspaceError("SEARCH_FAILED", error.message, error));
      const exited = () =>
        finish(new WorkspaceError("SEARCH_FAILED", "Search worker exited unexpectedly"));
      const message = (raw: unknown) => {
        const parsed = workerResponse.safeParse(raw);
        if (!parsed.success) {
          finish(
            new WorkspaceError("SEARCH_FAILED", "Malformed search worker result", parsed.error),
          );
          return;
        }
        const result = parsed.data;
        if ("error" in result) finish(new WorkspaceError("SEARCH_FAILED", result.error));
        else finish(undefined, result.matches);
      };
      // A byte cap alone does not bound backtracking regex CPU time.
      const deadline = this.runtime.deadline(5000, () => {
        void this.worker.terminate();
        finish(new WorkspaceError("SEARCH_FAILED", "Fallback regex exceeded its execution budget"));
      });
      signal?.addEventListener("abort", cancel, { once: true });
      this.worker.once("message", message);
      this.worker.once("error", failed);
      this.worker.once("exit", exited);
      this.worker.postMessage(request);
      if (signal?.aborted) cancel();
    });
  }
  async dispose(): Promise<void> {
    await this.worker.terminate();
  }
}

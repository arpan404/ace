import { SessionTotalsRequest, SessionTotalPage } from "./session-totals.ts";
import { Worker } from "node:worker_threads";
import { UsageBurn, UsageQuery, UsageResult } from "@ace/protocol";
import { WorkerConfig, WorkerRequest, WorkerResponse, type WorkerCall } from "./worker-wire.ts";
import { UsageBatch } from "./events.ts";
import { UsageSettings } from "./settings.ts";
import { QuotaWindow } from "./quotas.ts";
export class UsageWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; bytes: number }
  >();
  private sequence = 0;
  private bytes = 0;
  private failed: Error | undefined;
  private closing: Promise<void> | undefined;
  constructor(path: string, settings: unknown = {}) {
    const config = WorkerConfig.parse({ path, settings: UsageSettings.parse(settings) });
    this.worker = new Worker(new URL("./worker-entry.ts", import.meta.url), { workerData: config });
    this.worker.on("error", () => this.fail(new Error("Usage worker failed")));
    this.worker.on("exit", () => this.fail(new Error("Usage worker exited")));
    this.worker.on("message", (input: unknown) => {
      const parsed = WorkerResponse.safeParse(input);
      if (!parsed.success) {
        this.fail(new Error("Invalid usage worker response"));
        void this.worker.terminate();
        return;
      }
      const message = parsed.data;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      this.bytes -= pending.bytes;
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error("Usage operation rejected"));
    });
  }
  private fail(error: Error): void {
    this.failed = error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.bytes = 0;
  }
  private call(call: WorkerCall): Promise<unknown> {
    if (this.failed || this.closing)
      return Promise.reject(this.failed ?? new Error("Usage worker closing"));
    if (call.method !== "close" && this.pending.size >= 16)
      return Promise.reject(new Error("Usage worker backpressure"));
    const message = WorkerRequest.parse({ id: ++this.sequence, call });
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (bytes > 1024 * 1024 || (call.method !== "close" && this.bytes + bytes > 4 * 1024 * 1024))
      return Promise.reject(new Error("Usage worker byte backpressure"));
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject, bytes });
      this.bytes += bytes;
      try {
        this.worker.postMessage(message, []);
      } catch {
        this.pending.delete(message.id);
        this.bytes -= bytes;
        reject(new Error("Usage worker unavailable"));
      }
    });
  }
  async cursor(): Promise<number> {
    const value = await this.call({ method: "cursor" });
    if (typeof value !== "number") throw new Error("Invalid usage cursor");
    return value;
  }
  async ingest(batch: unknown): Promise<number> {
    const value = await this.call({ method: "ingest", batch: UsageBatch.parse(batch) });
    if (typeof value !== "number") throw new Error("Invalid usage cursor");
    return value;
  }
  async sessionTotalsFor(query: unknown) {
    return SessionTotalPage.parse(
      await this.call({ method: "sessionTotals", query: SessionTotalsRequest.parse(query) }),
    );
  }
  async summary(query: unknown) {
    return UsageResult.parse(
      await this.call({ method: "summary", query: UsageQuery.parse(query) }),
    );
  }
  async series(query: unknown) {
    return UsageResult.parse(await this.call({ method: "series", query: UsageQuery.parse(query) }));
  }
  async burn(account: string, window: unknown, now: number) {
    return UsageBurn.parse(
      await this.call({ method: "burn", account, window: QuotaWindow.parse(window), now }),
    );
  }
  close(): Promise<void> {
    if (!this.closing) {
      // One reserved control slot follows all admitted messages in the worker FIFO.
      const closed = this.call({ method: "close" });
      this.closing = (async () => {
        try {
          await closed;
        } finally {
          await this.worker.terminate();
        }
      })();
    }
    return this.closing;
  }
}

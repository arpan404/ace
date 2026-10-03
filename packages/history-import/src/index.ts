/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker_threads has no targetOrigin. */
import { Worker, type WorkerOptions } from "node:worker_threads";
import { IdleWorker, type WorkerPort } from "@ace/provider-kit/idle-worker";
import { InventoryWatch } from "./inventory-watch.ts";
type HistoryWorker = WorkerPort & { idle?(): void; started?: boolean };
import { Agent, ThreadId } from "@ace/protocol";
import {
  ArchiveCommand,
  ArchiveThread,
  PageRequest,
  PageResponse,
  BlobRequest,
  BlobResponse,
} from "./archive-contracts.ts";
import { z } from "zod";
import { HistoryListRequest, HistoryListResponse } from "@ace/protocol/history";
import {
  Options,
  ImportInit,
  ImportResult,
  Packet,
  Reply,
  Request,
  ScanResult,
  SessionOrNull,
  type HistoryOptions,
  type ImportSink,
} from "./contracts.ts";
export type { HistoryOptions, ImportSink, ProviderHome } from "./contracts.ts";
export type { HistorySession } from "@ace/protocol/history";

const Iteration = z.object({ done: z.boolean(), values: z.array(Packet).max(16) });
/** One worker owns writes; up to eight bounded reads may overlap its yielded scan. */
export async function openHistory(
  options: HistoryOptions,
  spawnWorker: (url: URL, options: WorkerOptions) => Worker = (url, workerOptions) =>
    new Worker(url, workerOptions),
): Promise<HistoryService> {
  const worker = new IdleWorker(
    new URL("./worker.ts", import.meta.url),
    {
      workerData: Options.parse(options),
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
    },
    {
      spawn: spawnWorker,
      delay(callback, milliseconds) {
        const timer = setTimeout(callback, milliseconds);
        timer.unref();
        return () => clearTimeout(timer);
      },
    },
  );
  const inventory = new InventoryWatch(Options.parse(options).instances);
  const service = new HistoryService(worker, inventory);
  worker.start();
  try {
    await service.ready;
    return service;
  } catch (error) {
    inventory.close();
    await worker.terminate();
    throw error;
  }
}
export class HistoryService {
  private worker: HistoryWorker;
  private archiveWriting = false;
  private inventory: InventoryWatch | undefined;
  private seq = 0;
  private pending:
    | { id: number; resolve: (value: unknown) => void; reject: (error: Error) => void }
    | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private requestDone: Promise<unknown> | undefined;
  private importing = false;
  private onProgress:
    | ((files: number, result: z.infer<typeof ScanResult>) => void | Promise<void>)
    | undefined;
  private reads = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private scanning = false;
  readonly ready: Promise<unknown>;
  constructor(worker: HistoryWorker, inventory?: InventoryWatch) {
    this.worker = worker;
    this.inventory = inventory;
    this.ready = new Promise((resolve, reject) => {
      this.pending = { id: 0, resolve, reject };
    });
    worker.on("message", (value: unknown) => {
      const progress = z
        .object({
          progress: z.number().int().nonnegative(),
          progressId: z.number().int(),
          result: ScanResult,
        })
        .safeParse(value).data;
      if (progress) {
        void Promise.resolve()
          .then(() => this.onProgress?.(progress.progress, progress.result))
          .finally(() => this.worker.postMessage({ progressAck: progress.progressId }))
          .catch(() => this.worker.postMessage("cancel"));
        return;
      }
      const reply = Reply.parse(value);
      const read = this.reads.get(reply.id);
      if (read) {
        this.reads.delete(reply.id);
        if (reply.error) read.reject(new Error(reply.error));
        else read.resolve(reply.value);
        this.retireIfIdle();
        return;
      }
      if (this.pending?.id !== reply.id) return;
      const pending = this.pending;
      this.pending = undefined;
      if (reply.error) pending.reject(new Error(reply.error));
      else pending.resolve(reply.value);
    });
    worker.on("error", (error) =>
      this.fail(error instanceof Error ? error : new Error(String(error))),
    );
    worker.on("exit", () => this.fail(new Error("History worker closed")));
  }
  private fail(error: Error) {
    this.closed = true;
    this.pending?.reject(error);
    this.pending = undefined;
    for (const read of this.reads.values()) read.reject(error);
    this.reads.clear();
  }
  private async request(request: z.infer<typeof Request>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (this.closed || (this.closing && request.op !== "close"))
      throw new Error("History service is closed");
    if (this.scanning && (request.op === "list" || request.op === "get")) {
      if (this.reads.size >= 8) throw new Error("Too many history reads");
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.reads.set(id, { resolve, reject });
        this.worker.postMessage({ id, request });
      });
    }
    if (this.pending) throw new Error("History operation already in progress");
    const id = ++this.seq;
    const cancel = () => this.worker.postMessage("cancel");
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const response = new Promise<unknown>((resolve, reject) => {
        this.pending = { id, resolve, reject };
        this.worker.postMessage({ id, request });
      });
      this.requestDone = response;
      const result = await response;
      signal?.throwIfAborted();
      return result;
    } finally {
      this.requestDone = undefined;
      this.retireIfIdle();
      signal?.removeEventListener("abort", cancel);
    }
  }
  async scan(
    signal?: AbortSignal,
    onProgress?: (files: number, result: z.infer<typeof ScanResult>) => void | Promise<void>,
  ) {
    return this.runScan({ op: "scan" }, signal, onProgress);
  }
  /** Consume observed changes. Explicit scan() stays authoritative when native events are delayed. */
  async scanChanges(
    signal?: AbortSignal,
    onProgress?: (files: number, result: z.infer<typeof ScanResult>) => void | Promise<void>,
  ) {
    if (this.importing || this.pending || this.scanning || this.closed || this.closing)
      throw new Error("History operation already in progress or closed");
    const changes = this.inventory?.take();
    return this.runScan(
      { op: "scan", ...(changes === undefined ? {} : { changes }) },
      signal,
      onProgress,
    );
  }
  subscribeChanges(listener: () => void): () => void {
    return this.inventory?.subscribe(listener) ?? (() => {});
  }
  private async runScan(
    request: Extract<z.infer<typeof Request>, { op: "scan" }>,
    signal?: AbortSignal,
    onProgress?: (files: number, result: z.infer<typeof ScanResult>) => void | Promise<void>,
  ) {
    if (this.importing) throw new Error("Import in progress");
    if (this.pending || this.scanning) throw new Error("History operation already in progress");
    this.onProgress = onProgress;
    this.scanning = true;
    try {
      const result = ScanResult.parse(await this.request(request, signal));
      this.inventory?.commit();
      return result;
    } catch (error) {
      this.inventory?.reset();
      throw error;
    } finally {
      this.onProgress = undefined;
      this.scanning = false;
      this.retireIfIdle();
    }
  }
  private retireIfIdle(): void {
    if (
      !this.importing &&
      !this.archiveWriting &&
      !this.scanning &&
      !this.pending &&
      !this.reads.size
    )
      this.worker.idle?.();
  }
  private requireIdle(): void {
    if (this.importing) throw new Error("Import in progress");
  }
  async list(request: z.input<typeof HistoryListRequest>) {
    this.requireIdle();
    return HistoryListResponse.parse(
      await this.request({ op: "list", request: HistoryListRequest.parse(request) }),
    );
  }
  async get(id: string) {
    this.requireIdle();
    return SessionOrNull.parse(await this.request({ op: "get", id }));
  }
  archiveSink(): ImportSink {
    const write = async (command: z.infer<typeof ArchiveCommand>) => {
      if (command.type === "rollback" && (this.closed || this.closing)) return;
      if (command.type === "begin") this.archiveWriting = true;
      try {
        await this.request({ op: "archive.write", command });
      } catch (error) {
        if (command.type === "begin") this.archiveWriting = false;
        throw error;
      } finally {
        if (command.type === "commit" || command.type === "rollback") this.archiveWriting = false;
        this.retireIfIdle();
      }
    };
    return {
      begin: (thread) => write({ type: "begin", thread }),
      appendAgent: (agent) => write({ type: "agent", agent }),
      appendItem: (item) => write({ type: "item", item }),
      beginBlob: (id, bytes) => write({ type: "blob.start", id, bytes }),
      appendBlob: (id, bytes) => write({ type: "blob.chunk", id, bytes }),
      endBlob: (id) => write({ type: "blob.end", id }),
      commit: () => write({ type: "commit" }),
      rollback: () => write({ type: "rollback" }),
    };
  }
  async findImported(sourceId: string) {
    this.requireIdle();
    return ArchiveThread.parse(await this.request({ op: "archive.source", id: sourceId }));
  }
  async importedThread(id: ThreadId) {
    this.requireIdle();
    return ArchiveThread.parse(await this.request({ op: "archive.thread", id }));
  }
  async deleteImported(id: ThreadId) {
    this.requireIdle();
    await this.request({ op: "archive.delete", id });
  }
  async importedAgents(id: ThreadId) {
    this.requireIdle();
    return z
      .array(Agent)
      .max(512)
      .parse(await this.request({ op: "archive.agents", id }));
  }
  async itemsPage(request: z.input<typeof PageRequest>) {
    this.requireIdle();
    return PageResponse.parse(
      await this.request({ op: "archive.page", request: PageRequest.parse(request) }),
    );
  }
  async readBlob(request: z.infer<typeof BlobRequest>) {
    this.requireIdle();
    return BlobResponse.parse(
      await this.request({ op: "archive.blob", request: BlobRequest.parse(request) }),
    );
  }
  async importSession(
    input: ImportInit,
    sink?: ImportSink,
    signal?: AbortSignal,
  ): Promise<{ messageCount: number; countAccuracy: "exact" | "sampled" }> {
    const init = ImportInit.parse(input);
    if (this.importing) throw new Error("Import in progress");
    this.importing = true;
    if (sink === undefined) {
      try {
        return ImportResult.parse(await this.request({ op: "import.persist", init }, signal));
      } finally {
        this.importing = false;
        this.retireIfIdle();
      }
    }
    let began = false;
    let count = 0;
    let ended = false;
    let countAccuracy: "exact" | "sampled" = "exact";
    try {
      let response = Iteration.parse(await this.request({ op: "import", init }, signal));
      for (;;) {
        for (const packet of response.values) {
          signal?.throwIfAborted();
          if (packet.type === "thread") {
            began = true;
            await sink.begin(packet.thread);
          } else if (packet.type === "agent") await sink.appendAgent(packet.agent);
          else if (packet.type === "item") await sink.appendItem(packet.item);
          else if (packet.type === "blob.start") await sink.beginBlob(packet.id, packet.bytes);
          else if (packet.type === "blob.chunk") await sink.appendBlob(packet.id, packet.bytes);
          else if (packet.type === "blob.end") await sink.endBlob(packet.id);
          else if (packet.type === "end") {
            countAccuracy = packet.countAccuracy;
            count = packet.messageCount;
            ended = true;
          }
        }
        if (response.done) break;
        response = Iteration.parse(await this.request({ op: "next" }, signal));
      }
      signal?.throwIfAborted();
      if (!ended) throw new Error("Incomplete history import");
      await sink.commit();
      return { messageCount: count, countAccuracy };
    } catch (error) {
      // Finish the generator to close source files and SQLite snapshots before rollback.
      if (!this.closed) await this.request({ op: "return" }).catch(() => undefined);
      if (began) await sink.rollback();
      throw error;
    } finally {
      this.importing = false;
      this.retireIfIdle();
    }
  }
  async continuation(
    sourceId: string,
    mode: "resume" | "fork",
    fork?: (input: { instanceId: string; nativeSessionId: string }) => Promise<string>,
  ) {
    const s = await this.get(sourceId);
    if (!s || s.support.status !== "supported") throw new Error("Session cannot be continued");
    if (s.provider === "claude" && s.parentNativeId)
      throw new Error("Claude sidechains continue through their parent session");
    const nativeSessionId =
      mode === "resume" ? s.nativeId : await this.nativeFork(s.instanceId, s.nativeId, fork);
    return {
      instanceId: s.instanceId,
      cwd: s.cwd,
      ...(s.model ? { model: s.model } : {}),
      resume: { nativeSessionId },
    };
  }
  private async nativeFork(
    instanceId: string,
    nativeSessionId: string,
    fork?: (input: { instanceId: string; nativeSessionId: string }) => Promise<string>,
  ) {
    if (!fork) throw new Error("Native fork capability is required");
    return z
      .string()
      .min(1)
      .max(1024)
      .parse(await fork({ instanceId, nativeSessionId }));
  }
  async close(): Promise<void> {
    this.inventory?.close();
    this.closing ??= (async () => {
      if (this.worker.started === false) {
        this.closed = true;
        await this.worker.terminate();
        return;
      }
      this.worker.postMessage("cancel");
      await this.requestDone?.catch(() => undefined);
      if (!this.closed) await this.request({ op: "close" });
      this.closed = true;
      await this.worker.terminate();
    })();
    await this.closing;
  }
}

export { openArchiveReader, type ArchiveReader } from "./archive-reader.ts";
export { ProviderHome as ProviderHomeSchema } from "./contracts.ts";

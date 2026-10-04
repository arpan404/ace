import { Worker, type WorkerOptions } from "node:worker_threads";
import {
  NotificationAddress,
  NotificationPreferences,
  type DeviceId,
  type Event,
  type PresenceUpdate,
  type ThreadId,
} from "@ace/protocol";
import type { NotificationTransport } from "./service.ts";
import { FromWorker, WorkerConfig, ToWorker, type WorkerCall } from "./worker-wire.ts";
import { metadata, type MetadataEvent } from "./metadata.ts";

export class NotificationWorker {
  private worker: Worker;
  private readonly ready: Promise<void>;
  private readyResolve: () => void = () => {};
  private readyReject: (error: Error) => void = () => {};
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve(value: number | undefined): void;
      reject(error: Error): void;
      bytes: number;
      disconnect: boolean;
    }
  >();
  private flights = new Map<number, AbortController>();
  private transport: NotificationTransport;
  private closing: Promise<void> | undefined;
  private failed: Error | undefined;
  private stopOnAbort: (() => void) | undefined;
  private pendingBytes = 0;
  private pendingDisconnects = 0;
  constructor(options: {
    path: string;
    windowMs?: number;
    transport: NotificationTransport;
    signal?: AbortSignal;
    spawn?: (entry: URL, options: WorkerOptions) => Worker;
  }) {
    this.transport = options.transport;
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Worker failure can precede the first RPC. Retain it without an unhandled rejection.
    void this.ready.catch(() => {});
    const spawn =
      options.spawn ?? ((entry: URL, config: WorkerOptions) => new Worker(entry, config));
    this.worker = spawn(new URL("./worker-entry.ts", import.meta.url), {
      workerData: WorkerConfig.parse(options),
    });
    this.worker.on("error", (error: unknown) =>
      this.fail(error instanceof Error ? error : new Error("Notification worker failed")),
    );
    this.worker.on("exit", () => this.fail(new Error("Notification worker exited")));
    let opened = false;
    if (options.signal) {
      const signal = options.signal;
      const abort = () => {
        if (opened) {
          // Quiesce transport delivery while keeping presence/database RPCs
          // available until the daemon's ordered cleanup reaches close.
          for (const flight of this.flights.values()) flight.abort();
          return;
        }
        this.fail(new DOMException("Notification worker aborted", "AbortError"));
        void this.worker.terminate();
      };
      signal.addEventListener("abort", abort, { once: true });
      this.stopOnAbort = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) abort();
    }
    this.worker.on("message", (input: unknown) => {
      const parsed = FromWorker.safeParse(input);
      if (!parsed.success) {
        this.fail(new Error("Invalid notification worker reply"));
        return;
      }
      const message = parsed.data;
      if (message.type === "ready") {
        opened = true;
        this.readyResolve();
      } else if (message.type === "result") {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        this.pendingBytes -= waiter?.bytes ?? 0;
        if (waiter?.disconnect) this.pendingDisconnects--;
        if (message.ok) waiter?.resolve(message.value);
        else waiter?.reject(new Error("Notification operation rejected"));
      } else if (message.type === "cancel") this.flights.get(message.id)?.abort();
      else {
        if (options.signal?.aborted || this.flights.size >= 16) {
          this.worker.postMessage({ type: "deliveryResult", id: message.id, result: "retry" }, []);
          return;
        }
        const controller = new AbortController();
        this.flights.set(message.id, controller);
        void this.transport
          .send(message.device, message.notification, controller.signal)
          .catch(() => "retry" as const)
          .then((result) => {
            this.flights.delete(message.id);
            if (!this.failed)
              this.worker.postMessage({ type: "deliveryResult", id: message.id, result }, []);
          });
      }
    });
  }
  private fail(error: Error): void {
    this.failed = error;
    this.readyReject(error);
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.pendingBytes = 0;
    this.pendingDisconnects = 0;
    for (const flight of this.flights.values()) flight.abort();
    this.flights.clear();
  }
  private call(call: WorkerCall): Promise<number | undefined> {
    if (this.failed) return Promise.reject(this.failed);
    if (this.closing && call.method !== "close")
      return Promise.reject(new Error("Notification worker closing"));
    const disconnect = call.method === "disconnect";
    // Cleanup has a separate bounded lane, so unrelated RPC pressure cannot lose presence.
    if (disconnect && this.pendingDisconnects >= 256)
      return Promise.reject(new Error("Notification cleanup backpressure"));
    if (call.method !== "close" && !disconnect && this.pending.size >= 64)
      return Promise.reject(new Error("Notification worker backpressure"));
    const id = ++this.sequence;
    const message = ToWorker.parse({ type: "call", id, call });
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (
      (disconnect && bytes > 2048) ||
      (call.method !== "close" &&
        !disconnect &&
        (bytes > 128 * 1024 || this.pendingBytes + bytes > 8 * 1024 * 1024))
    )
      return Promise.reject(new Error("Notification worker byte backpressure"));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, bytes, disconnect });
      if (disconnect) this.pendingDisconnects++;
      this.pendingBytes += bytes;
      void this.ready
        .then(() => {
          if (this.failed) throw this.failed;
          this.worker.postMessage(message, []);
        })
        .catch((error: unknown) => {
          if (this.pending.delete(id)) {
            this.pendingBytes -= bytes;
            if (disconnect) this.pendingDisconnects--;
          }
          reject(error);
        });
    });
  }
  async cursor(): Promise<number> {
    return (await this.call({ method: "cursor" })) ?? 0;
  }
  ingest(events: readonly Event[]): Promise<void> {
    if (events.length > 256)
      return Promise.reject(
        new Error("Notification ingestion batch exceeded 256; replay required"),
      );
    const first = events[0],
      last = events.at(-1);
    if (!first || !last) return Promise.resolve();
    for (let i = 1; i < events.length; i++) {
      if (events[i]?.seq !== (events[i - 1]?.seq ?? 0) + 1)
        return Promise.reject(new Error("Notification replay gap"));
    }
    return (async () => {
      let afterSeq = first.seq - 1,
        throughSeq = afterSeq;
      let compact: MetadataEvent[] = [];
      const flush = async () => {
        await this.call({ method: "ingest", afterSeq, throughSeq, events: compact });
        afterSeq = throughSeq;
        compact = [];
      };
      // Skip deltas without allocating/copying their payloads. Sixteen compact
      // records fit the byte budget even under worst-case JSON escaping.
      for (const event of events) {
        const projected = metadata(event);
        if (projected) compact.push(projected);
        throughSeq = event.seq;
        if (compact.length === 16) await flush();
      }
      if (throughSeq > afterSeq) await flush();
    })();
  }
  async connectDevice(device: DeviceId): Promise<void> {
    await this.call({ method: "connectDevice", device });
  }
  async register(device: DeviceId, address: unknown): Promise<void> {
    await this.call({ method: "register", device, address: NotificationAddress.parse(address) });
  }
  async preferences(device: DeviceId, input: unknown): Promise<void> {
    await this.call({
      method: "preferences",
      device,
      preferences: NotificationPreferences.parse(input),
    });
  }
  async snooze(thread: ThreadId, until: number): Promise<void> {
    await this.call({ method: "snooze", thread, until });
  }
  async updatePresence(session: string, device: DeviceId, update: PresenceUpdate): Promise<void> {
    await this.call({ method: "presence", session, device, update });
  }
  async disconnect(session: string): Promise<void> {
    await this.call({ method: "disconnect", session });
  }
  async revoke(device: DeviceId): Promise<void> {
    await this.call({ method: "revoke", device });
  }
  async drain(): Promise<void> {
    await this.call({ method: "drain" });
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      try {
        if (!this.failed) await this.call({ method: "close" });
      } finally {
        this.stopOnAbort?.();
        await this.worker.terminate();
      }
    })();
    return this.closing;
  }
}

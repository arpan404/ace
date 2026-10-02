import { Worker } from "node:worker_threads";
import {
  NotificationAddress,
  NotificationPreferences,
  type DeviceId,
  type Event,
  type PresenceUpdate,
  type ThreadId,
} from "@ace/protocol";
import type { NotificationTransport } from "./service.ts";
import { FromWorker, WorkerConfig, type WorkerCall } from "./worker-wire.ts";

/** Strip transcript, raw provider payloads and descriptions before copying across the worker boundary. */
function metadata(event: Event): Event | undefined {
  if (event.id.length > 200 || event.threadId.length > 200)
    throw new Error("Notification identifier too long");
  const p = event.payload;
  switch (p.type) {
    case "thread.created":
      return {
        ...event,
        payload: { ...p, thread: { ...p.thread, title: p.thread.title.slice(0, 200) } },
      };
    case "thread.updated":
      return {
        ...event,
        payload: { ...p, ...(p.title === undefined ? {} : { title: p.title.slice(0, 200) }) },
      };
    case "interaction.opened":
      return {
        ...event,
        payload: {
          ...p,
          interaction: {
            id: p.interaction.id,
            threadId: p.interaction.threadId,
            agentId: p.interaction.agentId,
            blocking: p.interaction.blocking,
            state: p.interaction.state,
            createdAt: p.interaction.createdAt,
            raw: [],
            request:
              p.interaction.request.kind === "approval"
                ? {
                    kind: "approval",
                    title: "",
                    options: p.interaction.request.options
                      .slice(0, 128)
                      .filter((option) => option.id.length <= 200)
                      .map((option) => ({ id: option.id, kind: option.kind, label: "" })),
                  }
                : { kind: "question", questions: [] },
          },
        },
      };
    case "interaction.closed":
      return {
        ...event,
        payload: {
          type: p.type,
          interactionId: p.interactionId,
          state: p.state,
          closedAt: p.closedAt,
        },
      };
    case "background_task.started":
      return {
        ...event,
        payload: {
          type: p.type,
          task: {
            id: p.task.id,
            agentId: p.task.agentId,
            kind: p.task.kind,
            status: p.task.status,
            ambient: p.task.ambient,
            stoppable: p.task.stoppable,
            startedAt: p.task.startedAt,
            title: "",
            raw: [],
          },
        },
      };
    case "background_task.updated":
      return event;
    default:
      return undefined;
  }
}
export class NotificationWorker {
  private worker: Worker;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve(value: number | undefined): void; reject(error: Error): void }
  >();
  private flights = new Map<number, AbortController>();
  private transport: NotificationTransport;
  private closing: Promise<void> | undefined;
  private failed: Error | undefined;
  constructor(options: { path: string; windowMs?: number; transport: NotificationTransport }) {
    this.transport = options.transport;
    this.worker = new Worker(new URL("./worker-entry.ts", import.meta.url), {
      workerData: WorkerConfig.parse(options),
    });
    this.worker.on("error", (error: unknown) =>
      this.fail(error instanceof Error ? error : new Error("Notification worker failed")),
    );
    this.worker.on("exit", () => this.fail(new Error("Notification worker exited")));
    this.worker.on("message", (input: unknown) => {
      const parsed = FromWorker.safeParse(input);
      if (!parsed.success) {
        this.fail(new Error("Invalid notification worker reply"));
        return;
      }
      const message = parsed.data;
      if (message.type === "result") {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.ok) waiter?.resolve(message.value);
        else waiter?.reject(new Error("Notification operation rejected"));
      } else if (message.type === "cancel") this.flights.get(message.id)?.abort();
      else {
        if (this.flights.size >= 16) {
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
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    for (const flight of this.flights.values()) flight.abort();
    this.flights.clear();
  }
  private call(call: WorkerCall): Promise<number | undefined> {
    if (this.failed) return Promise.reject(this.failed);
    if (this.pending.size >= 64)
      return Promise.reject(new Error("Notification worker backpressure"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: "call", id, call }, []);
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
    return this.call({
      method: "ingest",
      afterSeq: first.seq - 1,
      throughSeq: last.seq,
      events: events.flatMap((event) => {
        const compact = metadata(event);
        return compact ? [compact] : [];
      }),
    }).then(() => {});
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
        await this.call({ method: "close" });
      } finally {
        await this.worker.terminate();
      }
    })();
    return this.closing;
  }
}

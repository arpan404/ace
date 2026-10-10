import type {
  DeviceId,
  Event,
  Notification,
  NotificationDevice,
  PresenceUpdate,
  ThreadId,
} from "@ace/protocol";
import { metadata, type MetadataEvent } from "./metadata.ts";
import { NotificationDatabase } from "./database.ts";
import { PresenceIndex } from "./presence.ts";
import { isQuiet, retryDelay } from "./policy.ts";

export type DeliveryResult = "accepted" | "retry" | "gone" | "failed";
export interface NotificationTransport {
  send(
    device: NotificationDevice,
    notification: Notification,
    signal: AbortSignal,
  ): Promise<DeliveryResult>;
}
export interface NotificationLog {
  readEvents(options: { afterSeq: number; limit: number }): Event[];
  subscribe(listener: (events: Event[]) => void): () => void;
}
export interface NotificationOptions {
  path: string;
  now: () => number;
  jitter: () => number;
  transport: NotificationTransport;
  windowMs?: number;
  preview?: (thread: ThreadId) => string | undefined;
  onError?: (error: unknown) => void;
}
export class NotificationService {
  private database: NotificationDatabase;
  private presence = new PresenceIndex();
  private options: NotificationOptions;
  private inFlight = new Map<number, { device: DeviceId; controller: AbortController }>();
  private running: Promise<void> | undefined;
  private closed = false;
  constructor(options: NotificationOptions) {
    this.options = options;
    this.database = new NotificationDatabase(options.path, options.windowMs);
  }
  cursor(): number {
    return this.database.cursor();
  }
  ingest(events: readonly Event[], coverage?: { afterSeq: number; throughSeq: number }): void {
    const first = events[0],
      last = events.at(-1);
    if (!first || !last) return;
    for (let i = 1; i < events.length; i++) {
      if (events[i]?.seq !== (events[i - 1]?.seq ?? 0) + 1)
        throw new Error("Notification replay gap");
    }
    for (let i = 0; i < events.length; i += 256) {
      const page = events.slice(i, i + 256),
        begin = page[0],
        end = page.at(-1);
      if (!begin || !end) continue;
      this.ingestMetadata(
        page.flatMap((event) => {
          const projected = metadata(event);
          return projected ? [projected] : [];
        }),
        {
          afterSeq: i === 0 ? (coverage?.afterSeq ?? begin.seq - 1) : begin.seq - 1,
          throughSeq: i + 256 >= events.length ? (coverage?.throughSeq ?? end.seq) : end.seq,
        },
      );
    }
  }
  /** Parsed bounded events, used by the worker I/O boundary. */
  ingestMetadata(
    events: readonly MetadataEvent[],
    coverage: { afterSeq: number; throughSeq: number },
  ): void {
    this.database.ingest(events, this.options.now(), coverage);
  }
  register(id: DeviceId, address: unknown): void {
    this.database.register(
      id,
      address,
      this.options.now(),
      this.presence.activeDevices(this.options.now()),
    );
  }
  connectDevice(id: DeviceId): void {
    if (!this.database.device(id))
      this.database.register(
        id,
        { channel: "websocket", platform: "web" },
        this.options.now(),
        this.presence.activeDevices(this.options.now()),
      );
    this.database.touch(id, this.options.now());
  }
  getPreferences(id: DeviceId) {
    return this.database.device(id)?.preferences;
  }
  preferences(id: DeviceId, input: unknown): void {
    this.database.preferences(id, input);
  }
  notify(notification: Notification): void {
    this.database.notify(notification, this.options.now());
  }
  snooze(thread: ThreadId, until: number): void {
    this.database.snooze(thread, until);
  }
  updatePresence(session: string, device: DeviceId, update: PresenceUpdate): void {
    if (!this.database.device(device)) throw new Error("Device unavailable");
    this.presence.update(session, device, update, this.options.now());
    this.database.touch(device, this.options.now());
  }
  disconnect(session: string): void {
    this.presence.remove(session);
  }
  revoke(id: DeviceId): void {
    this.database.revoke(id);
    this.presence.revoke(id);
    for (const flight of this.inFlight.values())
      if (flight.device === id) flight.controller.abort();
  }
  /** No concurrent drains: at most sixteen requests, each transport has a deadline. */
  drain(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.running ??= this.deliver().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async deliver(): Promise<void> {
    const now = this.options.now();
    this.database.prepare(now);
    await Promise.all(
      this.database.due(now).map(async (job) => {
        const device = this.database.device(job.device.id);
        if (
          !device ||
          job.expires <= now ||
          !this.database.current(job.notification, job.generation) ||
          this.database.snoozed(job.notification.threadId, now) ||
          isQuiet(device.preferences, now) ||
          (job.notification.status === "agent_says" && device.preferences.agentSays === false) ||
          (device.address.platform === "phone" &&
            this.presence.viewedElsewhere(job.notification.threadId, device.id, now))
        ) {
          this.database.remove(job.id);
          return;
        }
        const controller = new AbortController();
        this.inFlight.set(job.id, { device: device.id, controller });
        let result: DeliveryResult;
        try {
          const preview = device.preferences.includePreview
            ? this.options.preview?.(job.notification.threadId)?.slice(0, 300)
            : undefined;
          result = await this.options.transport.send(
            device,
            preview ? { ...job.notification, preview } : job.notification,
            AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          );
        } catch (error) {
          this.options.onError?.(error);
          result = "retry";
        } finally {
          this.inFlight.delete(job.id);
        }
        if (result === "gone") this.revoke(device.id);
        if (result !== "retry" || job.attempts >= 4 || controller.signal.aborted)
          this.database.remove(job.id);
        else
          this.database.retry(
            job.id,
            job.attempts + 1,
            this.options.now() + retryDelay(job.attempts + 1, this.options.jitter()),
          );
      }),
    );
  }
  async close(): Promise<void> {
    if (this.closed) {
      await this.running;
      return;
    }
    this.closed = true;
    for (const flight of this.inFlight.values()) flight.controller.abort();
    await this.running;
    this.database.close();
  }
}
/** Replay catches subscriber failures from the durable cursor on the next tick. */
export function attachNotifications(
  service: Pick<NotificationService, "drain"> & {
    cursor(): number | Promise<number>;
    ingest(events: readonly Event[]): void | Promise<void>;
  },
  log: NotificationLog,
  onError: (error: unknown) => void,
): { recover(): Promise<boolean>; tick(): Promise<void>; close(): Promise<void> } {
  let running: Promise<void> | undefined;
  let closed = false;
  const ingestions = new Set<Promise<void>>();
  const replay = async () => {
    // Bounded work per tick; startup callers can tick until cursor reaches head.
    for (let page = 0; page < 16; page++) {
      if (closed) return false;
      const cursor = await service.cursor();
      if (closed) return false;
      const events = log.readEvents({ afterSeq: cursor, limit: 256 });
      if (!events.length) return true;
      await service.ingest(events);
    }
    return false;
  };
  const stop = log.subscribe((events) => {
    try {
      const ingested = service.ingest(events);
      if (ingested instanceof Promise) {
        const pending = ingested.catch(onError).finally(() => ingestions.delete(pending));
        ingestions.add(pending);
      }
    } catch (error) {
      onError(error);
    }
  });
  return {
    // Finite log recovery is separate from delivery and propagates initialization errors.
    recover: replay,
    tick() {
      if (closed) return Promise.resolve();
      running ??= (async () => {
        try {
          if ((await replay()) && !closed) await service.drain();
        } catch (error) {
          onError(error);
        }
      })().finally(() => {
        running = undefined;
      });
      return running;
    },
    async close() {
      closed = true;
      stop();
      await running;
      await Promise.all(ingestions);
    },
  };
}

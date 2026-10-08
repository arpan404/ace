import { setImmediate } from "node:timers/promises";
import { join } from "node:path";
import {
  NotificationWorker,
  attachNotifications,
  createNotificationRouter,
  type NotificationChannels,
} from "@ace/notify";
import type { DeviceId, Notification } from "@ace/protocol";
import { allows } from "./devices.ts";
import type { Store } from "./store.ts";

const offline = () => false;

export interface DaemonNotifications {
  service: NotificationWorker;
  setSender(sender: (device: DeviceId, notification: Notification) => boolean): void;
  open(): Promise<void>;
  ready(): Promise<void>;
  tick(): Promise<void>;
  activate(): void;
  start(): Promise<void>;
  stop(): void;
  close(): Promise<void>;
}
export function createDaemonNotifications(
  dataDir: string,
  store: Store,
  onError: (error: unknown) => void,
  channels: Omit<NotificationChannels, "websocket"> = {},
  windowMs = 5000,
  runtime: Pick<ConstructorParameters<typeof NotificationWorker>[0], "signal" | "spawn"> = {},
): DaemonNotifications {
  const deliveryLifetime = new AbortController();
  const signal = runtime.signal
    ? AbortSignal.any([runtime.signal, deliveryLifetime.signal])
    : deliveryLifetime.signal;
  const { spawn } = runtime;
  let send: (device: DeviceId, notification: Notification) => boolean = offline;
  const delivery = createNotificationRouter({
    ...channels,
    websocket: (device, notification) => send(device, notification),
  });
  const service = new NotificationWorker({
    path: join(dataDir, "notifications.sqlite"),
    windowMs,
    ...(signal ? { signal } : {}),
    ...(spawn ? { spawn } : {}),
    transport: {
      async send(device, notification, deliverySignal) {
        const paired = store.devices.get(device.id);
        if (paired?.revokedAt !== undefined && paired.revokedAt !== null) return "gone";
        if (paired && !allows(paired, "read")) return "failed";
        return delivery.send(device, notification, deliverySignal);
      },
    },
  });
  const attached = attachNotifications(
    {
      cursor: () => service.cursor(signal),
      // Admitted ingestion remains durable shutdown work, not cancellable startup.
      ingest: (events) => service.ingest(events),
      async drain() {
        for (const entry of store.readMcpIntents(64, "mcp.notify")) {
          if (entry.intent.type !== "mcp.notify") continue;
          const thread = store.getThread(entry.intent.threadId);
          if (thread)
            await service.notify({
              id: `mcp:${entry.id}`,
              threadId: thread.id,
              title: thread.title.slice(0, 200),
              status: "agent_says",
              message: entry.intent.notice.text.slice(0, 300),
              backgroundCount: 0,
              actions: [],
            });
          await store.writable();
          store.acknowledgeMcpIntent(entry.id);
        }
        await service.drain();
      },
    },
    store,
    (error) => {
      if (signal.aborted && error instanceof Error && error.name === "AbortError") return;
      onError(error);
    },
  );
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const startups = new Set<Promise<void>>();
  const cancelled = () => {
    signal.throwIfAborted();
    if (closed) throw new DOMException("Notification startup aborted", "AbortError");
  };
  const track = (operation: Promise<void>) => {
    startups.add(operation);
    void operation.then(
      () => startups.delete(operation),
      () => startups.delete(operation),
    );
    return operation;
  };
  const open = () =>
    track(
      (async () => {
        cancelled();
        await service.cursor(signal);
        cancelled();
      })(),
    );
  let readiness: Promise<void> | undefined;
  const ready = () => {
    readiness ??= track(
      (async () => {
        cancelled();
        await service.cursor(signal);
        cancelled();
        // Check after every RPC before scheduling another one, especially durable revocations.
        for (const device of store.devices.list()) {
          if (device.revokedAt === null) continue;
          cancelled();
          await service.revoke(device.id, signal);
          cancelled();
        }
        for (;;) {
          const recovered = await attached.recover();
          cancelled();
          if (recovered) return;
          await setImmediate();
          cancelled();
        }
      })(),
    );
    return readiness;
  };
  const activate = () => {
    signal?.throwIfAborted();
    if (closed) throw new DOMException("Notification startup aborted", "AbortError");
    if (timer) return;
    // Replay and delivery ticks are lifetime work, separate from readiness.
    void attached.tick();
    timer = setInterval(() => {
      void attached.tick();
    }, 1000);
    timer.unref();
  };
  let stopped: Promise<void> | undefined;
  const stop = () => {
    closed = true;
    deliveryLifetime.abort();
    if (timer) clearInterval(timer);
    stopped ??= (async () => {
      await attached.close();
      // Settle startup RPC continuations before the worker enters its closing state.
      await Promise.allSettled(startups);
    })();
  };
  return {
    stop,
    service,
    open,
    ready,
    tick: attached.tick,
    activate,
    setSender(sender) {
      send = sender;
    },
    async start() {
      await ready();
      activate();
    },
    async close() {
      stop();
      await stopped;
      await service.close();
    },
  };
}

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
  const attached = attachNotifications(service, store, (error) => {
    if (signal?.aborted && error instanceof Error && error.name === "AbortError") return;
    onError(error);
  });
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const ready = async () => {
    await service.cursor();
    // Revocation is durable authority, independent of whether delivery has a job.
    for (const device of store.devices.list())
      if (device.revokedAt !== null) await service.revoke(device.id);
    while (!(await attached.recover())) {
      signal?.throwIfAborted();
      if (closed) throw new DOMException("Notification recovery aborted", "AbortError");
      await setImmediate();
    }
    signal?.throwIfAborted();
    if (closed) throw new DOMException("Notification startup aborted", "AbortError");
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
    stopped ??= attached.close();
  };
  return {
    stop,
    service,
    open: async () => {
      await service.cursor();
    },
    ready,
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

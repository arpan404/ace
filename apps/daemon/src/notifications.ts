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
  ready(): Promise<void>;
  activate(): void;
  start(): Promise<void>;
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
  const { signal, spawn } = runtime;
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
  const attached = attachNotifications(service, store, onError);
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const ready = async () => {
    await service.cursor();
    await attached.recover();
    if (closed || signal?.aborted) throw new Error("Notification startup aborted");
  };
  const activate = () => {
    if (closed || signal?.aborted) throw new Error("Notification startup aborted");
    if (timer) return;
    // Replay and delivery ticks are lifetime work, separate from readiness.
    void attached.tick();
    timer = setInterval(() => {
      void attached.tick();
    }, 1000);
    timer.unref();
  };
  return {
    service,
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
      closed = true;
      if (timer) clearInterval(timer);
      attached.close();
      await service.close();
    },
  };
}

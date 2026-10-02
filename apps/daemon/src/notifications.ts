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
  start(): Promise<void>;
  close(): Promise<void>;
}
export function createDaemonNotifications(
  dataDir: string,
  store: Store,
  onError: (error: unknown) => void,
  channels: Omit<NotificationChannels, "websocket"> = {},
  windowMs = 5000,
): DaemonNotifications {
  let send: (device: DeviceId, notification: Notification) => boolean = offline;
  const delivery = createNotificationRouter({
    ...channels,
    websocket: (device, notification) => send(device, notification),
  });
  const service = new NotificationWorker({
    path: join(dataDir, "notifications.sqlite"),
    windowMs,
    transport: {
      async send(device, notification, signal) {
        const paired = store.devices.get(device.id);
        if (paired?.revokedAt !== undefined && paired.revokedAt !== null) return "gone";
        if (paired && !allows(paired, "read")) return "failed";
        return delivery.send(device, notification, signal);
      },
    },
  });
  const attached = attachNotifications(service, store, onError);
  let timer: NodeJS.Timeout | undefined;
  return {
    service,
    setSender(sender) {
      send = sender;
    },
    async start() {
      await service.cursor();
      await attached.tick();
      timer = setInterval(() => {
        void attached.tick();
      }, 1000);
      timer.unref();
    },
    async close() {
      if (timer) clearInterval(timer);
      attached.close();
      await service.close();
    },
  };
}

import { join } from "node:path";
import {
  NotificationWorker,
  attachNotifications,
  createNotificationRouter,
  type NotificationChannels,
} from "@ace/notify";
import type { DeviceId, Notification } from "@ace/protocol";
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
): DaemonNotifications {
  let send: (device: DeviceId, notification: Notification) => boolean = offline;
  const service = new NotificationWorker({
    path: join(dataDir, "notifications.sqlite"),
    transport: createNotificationRouter({
      ...channels,
      websocket: (device, notification) => send(device, notification),
    }),
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

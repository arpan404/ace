import { warmup } from "./warmup.ts";
import { loadNotificationChannels } from "../notification-config.ts";
import { createDaemonNotifications } from "../notifications.ts";
import type { ServiceContext } from "./types.ts";
export async function startNotifications(context: ServiceContext): Promise<void> {
  const { config, options, store, resources, services, log, onListen } = context;

  const configured = options.notificationChannels
    ? { channels: options.notificationChannels, close: () => {} }
    : await loadNotificationChannels();
  resources.own(configured.close);
  const notifications = createDaemonNotifications(
    config.dataDir,
    store,
    (error) => log.log("error", "Notification service failure", error),
    configured.channels,
    5000,
    {
      signal: context.signal,
      ...(options.notificationWorker ? { spawn: options.notificationWorker } : {}),
    },
  );
  resources.own(() => notifications.close());
  // A cursor reply proves the worker has opened its store, even when the log is empty.
  await notifications.open();
  services.notifications = notifications.service;
  onListen.push(async (server) => {
    notifications.setSender(server.notify);
    // Clients can connect through the endpoint before feature startup completes.
    for (const device of server.notificationDevices())
      await notifications.service.connectDevice(device);
    void warmup(context, "notifications", async () => {
      await notifications.ready();
      notifications.activate();
    });
  });
}

import type { SocketContext, SocketService } from "./socket.ts";
export function createNotificationsSession({
  options,
  authorize,
  sessionId,
  onPresence,
  fail,
}: SocketContext): SocketService {
  return {
    async handle(message, device) {
      switch (message.type) {
        case "presence.update":
        case "notification.register":
        case "notification.preferences":
        case "notification.snooze": {
          const scope = message.type === "notification.snooze" ? "operate" : "read";
          if (!authorize(scope)) {
            fail("forbidden", `${scope === "read" ? "Read" : "Operate"} scope required`);
            return true;
          }
          if (!options.notifications) {
            fail("notifications_unavailable", "Notifications unavailable");
            return true;
          }
          try {
            if (message.type === "presence.update") {
              onPresence();
              await options.notifications.updatePresence(sessionId, device, message);
            } else if (message.type === "notification.register")
              await options.notifications.register(device, message.device);
            else if (message.type === "notification.preferences")
              await options.notifications.preferences(device, message.preferences);
            else await options.notifications.snooze(message.threadId, message.until);
          } catch {
            fail("notification_rejected", "Notification update rejected");
          }
          return true;
        }
      }
      return false;
    },
  };
}

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
    () => log.log("error", "Notification service failure"),
    configured.channels,
  );
  resources.own(() => notifications.close());
  services.notifications = notifications.service;
  onListen.push(async (server) => {
    notifications.setSender(server.notify);
    await notifications.start();
  });
}

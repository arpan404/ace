import type { DeviceId, Notification } from "@ace/protocol";
import type { NotificationTransport } from "./service.ts";

export interface NotificationChannels {
  websocket: (device: DeviceId, notification: Notification) => boolean;
  webpush?: NotificationTransport;
  apns?: NotificationTransport;
  fcm?: NotificationTransport;
}
/** Relay-side FCM implements this same bounded, abortable transport contract. */
export function createNotificationRouter(channels: NotificationChannels): NotificationTransport {
  return {
    async send(device, notification, signal) {
      if (signal.aborted) return "retry";
      // Connected clients receive the alert immediately; offline clients use their registered push address.
      if (channels.websocket(device.id, notification)) return "accepted";
      const channel = device.address.channel;
      if (channel === "websocket") return "retry";
      return channels[channel]?.send(device, notification, signal) ?? "failed";
    },
  };
}

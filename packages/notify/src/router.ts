import type { DeviceId, Notification } from "@ace/protocol";
import type { NotificationTransport } from "./service.ts";

export interface NotificationChannels {
  websocket: (device: DeviceId, notification: Notification) => boolean;
  /**
   * For a phone that can be pushed: true only once its app acknowledged the live frame
   * (`notification.ack`). A suspended app can keep its socket open, so a sent frame alone
   * is not a delivery (ADR 0106).
   */
  acknowledged?: (device: DeviceId, notification: Notification) => Promise<boolean>;
  webpush?: NotificationTransport;
  apns?: NotificationTransport;
  fcm?: NotificationTransport;
  push?: NotificationTransport;
}
/** Relay-side FCM implements this same bounded, abortable transport contract. */
export function createNotificationRouter(channels: NotificationChannels): NotificationTransport {
  return {
    async send(device, notification, signal) {
      if (signal.aborted) return "retry";
      const channel = device.address.channel;
      // Connected clients receive the alert immediately; offline clients use their registered push address.
      const live =
        channel === "push" && channels.acknowledged
          ? await channels.acknowledged(device.id, notification)
          : channels.websocket(device.id, notification);
      if (live) return "accepted";
      if (signal.aborted) return "retry";
      if (channel === "websocket") return "retry";
      return channels[channel]?.send(device, notification, signal) ?? "failed";
    },
  };
}
